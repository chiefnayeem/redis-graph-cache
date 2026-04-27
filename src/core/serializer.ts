/**
 * Serializer - Pluggable (de)serialization for entity payloads.
 *
 * The default serializer (`TAGGED_SERIALIZER`) is a lossless wrapper
 * around `JSON.stringify` / `JSON.parse` that preserves JS types JSON
 * cannot represent natively. It uses a tag-based envelope only for
 * non-JSON-native values; everything else round-trips identically to
 * plain `JSON.stringify` so the on-wire format is unchanged for
 * ordinary data (strings, numbers, booleans, plain objects, arrays,
 * nulls).
 *
 * Why the engine needs this:
 *   - `Date` becomes an ISO string via `Date.prototype.toJSON` and
 *     parses back as a string, breaking `post.createdAt.getTime()`.
 *   - `BigInt` throws `TypeError` from `JSON.stringify`.
 *   - `Map`, `Set`, `RegExp`, `Buffer` serialize to `{}`, losing all
 *     contents.
 *   - `NaN`, `Infinity`, `-Infinity` become `null`, silently corrupting
 *     numeric stats fields.
 *
 * Out of scope (intentionally NOT tagged):
 *   - `undefined`. The engine's merge semantics treat
 *     "field is undefined" identically to "field is omitted" so that
 *     partial updates don't accidentally clobber existing values.
 *     See `NULL_UNDEFINED_HANDLING.md`. Tagging undefined would
 *     silently change that contract.
 *
 * Backward compatibility:
 *   - Reads of plain JSON written by older versions (or by any process
 *     without this engine) work unchanged. The reviver only transforms
 *     objects that carry the internal tag key.
 *   - Writes that contain only JSON-native values produce byte-for-byte
 *     identical output to the previous `JSON.stringify` path.
 *
 * Pluggability:
 *   - Consumers can opt out by passing `cache.serializer = JSON_SERIALIZER`
 *     (raw, no tagging — original behaviour).
 *   - Consumers can plug in a third-party codec like `superjson` or
 *     `devalue` by passing any object that implements `Serializer`.
 */

/**
 * Minimal contract every serializer must satisfy. The engine never
 * inspects intermediate forms; it only ever calls `stringify` to
 * produce the on-wire string and `parse` to recover the structured
 * value.
 */
export interface Serializer {
  /** Serialize a structured value to the string Redis stores. */
  stringify(value: any): string;
  /** Deserialize a string read from Redis back to a structured value. */
  parse(value: string): any;
}

/**
 * Internal tag key used by the default tagged serializer. It is
 * deliberately under the engine's reserved `__rse_` prefix so it
 * cannot collide with user fields (schema validation rejects field
 * names starting with `__rse_`).
 */
const TAG = '__rse_t';

/**
 * Replacer used by `TAGGED_SERIALIZER.stringify`. Receives the
 * pre-`toJSON` value via `this[key]` so we can detect `Date`,
 * `Buffer`, etc. before their built-in `toJSON` clobbers them.
 *
 * Any value not matched here is returned unchanged, so plain JSON
 * data round-trips with zero envelope overhead.
 */
function tagReplacer(this: any, key: string, value: any): any {
  // `this` is the holder object; `value` is the post-`toJSON` value.
  // We need the raw value to detect Date/Buffer/etc. since their
  // `toJSON` runs before the replacer.
  const original = this[key];

  if (original instanceof Date) {
    // `getTime()` preserves invalid dates (NaN) which `toISOString`
    // would throw on. Storing the numeric timestamp is also slightly
    // smaller and unambiguous across timezones.
    const t = original.getTime();
    return { [TAG]: 'Date', v: Number.isNaN(t) ? null : t };
  }

  if (typeof original === 'bigint') {
    return { [TAG]: 'BigInt', v: original.toString() };
  }

  if (original instanceof Map) {
    // Entries are arrays of [key, value]; both will recurse through
    // the replacer so nested Dates/BigInts inside a Map work too.
    return { [TAG]: 'Map', v: Array.from(original.entries()) };
  }

  if (original instanceof Set) {
    return { [TAG]: 'Set', v: Array.from(original.values()) };
  }

  if (original instanceof RegExp) {
    return { [TAG]: 'RegExp', src: original.source, flags: original.flags };
  }

  // Buffer check is guarded so the serializer also works in non-Node
  // environments (Edge, browsers) where `Buffer` is undefined.
  if (
    typeof Buffer !== 'undefined' &&
    typeof (Buffer as any).isBuffer === 'function' &&
    (Buffer as any).isBuffer(original)
  ) {
    return { [TAG]: 'Buffer', v: (original as Buffer).toString('base64') };
  }

  if (typeof original === 'number' && !Number.isFinite(original)) {
    if (Number.isNaN(original)) return { [TAG]: 'Number', v: 'NaN' };
    return {
      [TAG]: 'Number',
      v: original > 0 ? 'Infinity' : '-Infinity',
    };
  }

  return value;
}

/**
 * Reviver used by `TAGGED_SERIALIZER.parse`. JSON.parse calls the
 * reviver bottom-up (children first), so by the time we see a tagged
 * envelope its inner `v` has already been revived. That means
 * `Map<Date, BigInt>` round-trips correctly: the inner Dates and
 * BigInts are reconstructed before the Map wraps them.
 *
 * Untagged objects (plain JSON written by any other producer) are
 * returned unchanged, which is what makes this safe to deploy on top
 * of an existing cache.
 */
function tagReviver(_key: string, value: any): any {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !(TAG in value)
  ) {
    return value;
  }

  switch (value[TAG]) {
    case 'Date':
      // `null` in `v` means we serialized an Invalid Date; reconstruct
      // it so identity round-trips even for that weird case.
      return value.v === null ? new Date(NaN) : new Date(value.v);

    case 'BigInt':
      return BigInt(value.v);

    case 'Map':
      return new Map(value.v);

    case 'Set':
      return new Set(value.v);

    case 'RegExp':
      return new RegExp(value.src, value.flags);

    case 'Buffer':
      // Guarded for non-Node environments. If Buffer is unavailable
      // we return the raw envelope so the consumer at least sees the
      // base64 payload rather than getting `undefined`.
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(value.v, 'base64');
      }
      return value;

    case 'Number':
      if (value.v === 'NaN') return NaN;
      if (value.v === 'Infinity') return Infinity;
      if (value.v === '-Infinity') return -Infinity;
      return Number(value.v);

    default:
      // Unknown tag — return the envelope as-is. This is forward
      // compatible: a future engine version may add new tags and
      // older readers will simply pass them through instead of
      // crashing.
      return value;
  }
}

/**
 * Default serializer. Lossless for `Date`, `BigInt`, `Map`, `Set`,
 * `RegExp`, `Buffer`, `NaN`, `+Infinity`, `-Infinity`. Identical to
 * plain JSON for all other values.
 */
export const TAGGED_SERIALIZER: Serializer = {
  stringify(value: any): string {
    return JSON.stringify(value, tagReplacer);
  },
  parse(value: string): any {
    return JSON.parse(value, tagReviver);
  },
};

/**
 * Plain JSON serializer. No tagging, no reviver. Use this when you
 * know your data is JSON-native and want zero serialization overhead,
 * or when interoperating with non-engine readers that expect raw JSON.
 *
 * Trade-off: `Date` survives as ISO string only, `BigInt` will throw,
 * `Map`/`Set`/`RegExp`/`Buffer` lose all data, `NaN`/`Infinity` become
 * `null`. This is the historical engine behaviour; kept available for
 * opt-out.
 */
export const JSON_SERIALIZER: Serializer = {
  stringify(value: any): string {
    return JSON.stringify(value);
  },
  parse(value: string): any {
    return JSON.parse(value);
  },
};

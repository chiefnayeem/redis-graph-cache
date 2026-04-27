/**
 * Optional value compression for entity payloads.
 *
 * Why this exists:
 *   - Entity payloads (post + nested relationships) can be 5-50 KB.
 *   - At 50k concurrent users this is meaningful network bandwidth and
 *     Redis memory pressure.
 *   - Compression cuts typical JSON to ~30% of original size; even with
 *     base64 envelope overhead the net saving is 50-60%.
 *
 * Why ONLY entity values are compressed (not list values):
 *   - List values are JSON arrays of ids that the atomic Lua scripts
 *     parse server-side via `cjson.decode`. Compressed payloads would
 *     not parse and would break list-add / list-remove atomic ops.
 *   - Entity values are always parsed in Node, never inside Redis, so
 *     they're safe to ship in a compressed envelope.
 *
 * Backward compatibility:
 *   - Plain JSON (starts with `{` or `[`) is returned untouched on
 *     decode, so existing keys keep working when compression is enabled.
 *   - Compressed values carry a 4-character magic prefix `\x00z1:` that
 *     cannot occur at the start of valid JSON.
 *   - Writers can disable compression at any time and readers will
 *     transparently handle a mix of compressed and uncompressed values.
 */

import * as zlib from 'zlib';

const MAGIC = '\x00z1:';
const MAGIC_LENGTH = MAGIC.length;

/**
 * Wraps the (de)serialisation of an entity JSON string. A no-op codec
 * (`enabled = false`) returns inputs unchanged on both encode and decode,
 * with a fast-path so the engine pays virtually zero cost when the
 * feature is off.
 */
export class CompressionCodec {
  public readonly enabled: boolean;
  public readonly threshold: number;

  constructor(enabled: boolean, threshold: number) {
    this.enabled = enabled;
    // Threshold is in bytes; clamp to a sensible minimum to avoid
    // compressing tiny values where the envelope overhead outweighs the
    // saving.
    this.threshold = Math.max(64, threshold || 1024);
  }

  /**
   * Encode a value for storage. When compression is disabled or the
   * payload is below the threshold, returns the input unchanged so we
   * don't add overhead to small entities.
   */
  encode(value: string): string {
    if (!this.enabled) return value;
    if (Buffer.byteLength(value, 'utf8') < this.threshold) return value;
    const compressed = zlib.deflateRawSync(Buffer.from(value, 'utf8'));
    return MAGIC + compressed.toString('base64');
  }

  /**
   * Decode a value read from Redis. Detects the magic prefix to decide
   * whether to inflate. Untagged values pass through, which is what
   * makes this safe to deploy on top of an existing cache: any data
   * written before compression was enabled keeps reading correctly.
   *
   * Throws if a tagged value is malformed; that's a hard error worth
   * surfacing because it indicates corruption rather than a stale
   * format.
   */
  decode(value: string): string {
    if (!value.startsWith(MAGIC)) return value;
    const b64 = value.slice(MAGIC_LENGTH);
    const buf = Buffer.from(b64, 'base64');
    return zlib.inflateRawSync(buf).toString('utf8');
  }
}

/**
 * Fast-path codec used when compression is disabled. Defined separately
 * so the hot path doesn't even branch on `enabled` per call.
 */
export const NOOP_CODEC = new CompressionCodec(false, 0);

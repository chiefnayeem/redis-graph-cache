/**
 * Core schema type definitions for Redis Schema Engine
 */

/**
 * Recognized field types for documentation / schema validation.
 *
 * IMPORTANT: field types are **advisory** — the engine does NOT coerce
 * or transform values based on them. They exist so schemas are
 * self-documenting and so obvious typos (e.g. `type: 'stirng'`) are
 * caught at registration time. Actual type preservation across cache
 * round-trips is handled by the configured `Serializer`.
 *
 * The first-class JSON types (`string`, `number`, `boolean`, `object`,
 * `array`) round-trip through raw JSON unchanged. The extended types
 * (`date`, `bigint`, `map`, `set`, `regexp`, `buffer`) require the
 * default `TAGGED_SERIALIZER` (enabled by default) to round-trip
 * losslessly; with `JSON_SERIALIZER` they degrade per the compatibility
 * table in `USAGE.md`.
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'date'
  | 'bigint'
  | 'map'
  | 'set'
  | 'regexp'
  | 'buffer';
export type RelationKind = 'one' | 'many';

export interface FieldDefinition {
  type: FieldType;
  required?: boolean;
  validation?: (value: any) => boolean;
}

export interface RelationDefinition {
  type: string;
  kind: RelationKind;
  cascade?: boolean;
  lazy?: boolean;
}

export interface EntitySchema {
  type: 'entity';
  id: string;
  key: (...args: any[]) => string;
  fields?: Record<string, FieldDefinition>;
  relations?: Record<string, RelationDefinition>;
  ttl?: number;
  version?: string;
}

export interface ListSchema {
  type: 'list';
  entityType: string;
  key: (...args: any[]) => string;
  idField: string;
  ttl?: number;
  version?: string;
}

/**
 * ZSET-backed list schema. Use this instead of `ListSchema` for any list
 * that may grow beyond a few hundred entries, needs paginated reads, needs
 * efficient atomic add/remove, or needs to be sorted by something other
 * than insertion order.
 *
 * Storage: a Redis sorted set (`ZSET`) where each member is the entity id
 * and each score is either the value of `scoreField` on the entity (when
 * specified and numeric) or the insertion timestamp in milliseconds.
 *
 * Why a separate type: keeping `ListSchema` and `IndexedListSchema`
 * distinct lets existing code that uses the JSON-array list type keep
 * working with no migration. New high-traffic lists adopt the indexed
 * type, old ones stay where they are.
 */
export interface IndexedListSchema {
  type: 'indexedList';
  entityType: string;
  key: (...args: any[]) => string;
  idField: string;
  /**
   * Name of the entity field used as the ZSET score. Must resolve to a
   * finite number on the entity (or a value that `Number()` converts to
   * one — e.g. an ISO timestamp string, a numeric string, a Date). When
   * omitted, members are scored by `Date.now()` at insertion time, which
   * yields newest-first feeds when read in reverse order.
   */
  scoreField?: string;
  /**
   * Optional cap on list size. When set, every atomic insert trims the
   * list back to at most `maxSize` entries by ZREMRANGEBYRANK, dropping
   * the lowest-scored members. Use this for "latest N" feeds where older
   * items can be discarded.
   */
  maxSize?: number;
  /**
   * When true, every insert also records a back-index entry mapping
   * `entityId -> listKey` so `invalidateEntity` can cascade through and
   * atomically remove the id from every tracked list it appears in.
   * Default false (no overhead) since membership tracking only matters
   * for entities that participate in many lists.
   */
  trackMembership?: boolean;
  ttl?: number;
  version?: string;
}

export type SchemaDefinition = EntitySchema | ListSchema | IndexedListSchema;

export interface Schema {
  [key: string]: SchemaDefinition;
}

export interface SchemaValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

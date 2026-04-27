/**
 * Internal data structures and metadata types for Redis Schema Engine
 */

export interface EntityMetadata {
  entityType: string;
  originalId: string | number;
  relationshipIds: Record<string, any>;
  lastUpdated: number;
  source: string;
  version?: string;
}

export interface NormalizedEntity {
  [key: string]: any;
  __rse_version?: string;
  __rse_timestamp?: number;
  __rse_metadata?: EntityMetadata;
}

export interface HydrationContext {
  visitedEntities: Set<string>;
  currentDepth: number;
  maxDepth: number;
  memoryUsage: number;
  maxMemory: number;
  requestId: string;
  selectiveFields?: string[];
  excludeRelations?: string[];
}

export interface PipelineOperation {
  type: 'GET' | 'SET' | 'DEL' | 'MGET' | 'MSET';
  key?: string;
  keys?: string[];
  value?: string;
  values?: Record<string, string>;
}

export interface PipelineResult {
  success: boolean;
  results: any[];
  errors: Error[];
  operationCount: number;
  executionTime: number;
}

export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

export interface FallbackOptions {
  enableFallback?: boolean;
  strategy?: 'null' | 'empty' | 'cached' | 'custom';
  customFallback?: () => Promise<any>;
}

// Internal field naming constants
export const INTERNAL_FIELD_PREFIX = '__rse_';
export const VERSION_FIELD = '__rse_version';
export const TIMESTAMP_FIELD = '__rse_timestamp';
export const METADATA_FIELD = '__rse_metadata';

// Key generation utilities
export const generateEntityKey = (
  entityType: string,
  id: string | number,
): string => {
  return `${entityType}:${id}`;
};

export const generateListKey = (listType: string, ...params: any[]): string => {
  return `${listType}:${params.join(':')}`;
};

export const generateRelationIdField = (
  relationName: string,
  kind: 'one' | 'many',
): string => {
  return kind === 'one'
    ? `${INTERNAL_FIELD_PREFIX}${relationName}Id`
    : `${INTERNAL_FIELD_PREFIX}${relationName}Ids`;
};

export const isInternalField = (fieldName: string): boolean => {
  return fieldName.startsWith(INTERNAL_FIELD_PREFIX);
};

/**
 * Return true iff `value` is a plain `{ ... }` object literal (as
 * opposed to an array, a Date/Map/Set/RegExp/Buffer, or some other
 * class instance). Used by `stripInternalFields` to decide whether to
 * recurse: recursing into a class instance would destroy it by copying
 * its enumerable own properties into a fresh `{}` (a `Date` has none,
 * so it becomes `{}` — a subtle data-loss bug the engine has to avoid
 * now that the tagged serializer can surface real class instances).
 */
const isPlainObject = (value: any): boolean => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const stripInternalFields = (obj: any): any => {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => stripInternalFields(item));
  }

  // Preserve class instances (Date, Map, Set, RegExp, Buffer, or any
  // user-supplied class) verbatim. Recursing into them would call
  // `Object.entries` which returns `[]` for most built-ins, collapsing
  // them into an empty `{}` and silently losing the value.
  if (!isPlainObject(obj)) return obj;

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!isInternalField(key)) {
      // Only recurse into plain objects / arrays. Class instances are
      // assigned by reference so their identity and type survive.
      result[key] =
        value &&
        typeof value === 'object' &&
        (Array.isArray(value) || isPlainObject(value))
          ? stripInternalFields(value)
          : value;
    }
  }

  return result;
};

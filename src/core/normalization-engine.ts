/**
 * Normalization Engine - Converts nested objects into normalized Redis storage
 */

import { SchemaManager } from './schema-manager';
import { RedisConnectionManager } from './redis-connection-manager';
import { CompressionCodec, NOOP_CODEC } from './compression';
import { Serializer, TAGGED_SERIALIZER } from './serializer';
import {
  NormalizedEntity,
  EntityMetadata,
  WriteResult,
  RelationDefinition,
  generateRelationIdField,
  INTERNAL_FIELD_PREFIX,
  VERSION_FIELD,
  TIMESTAMP_FIELD,
  METADATA_FIELD,
  InvalidOperationError,
  RedisConnectionError,
} from '../types';

export interface NormalizationResult {
  normalizedEntities: Map<string, NormalizedEntity>;
  primaryEntityKey: string;
  operationId: string;
}

export class NormalizationEngine {
  constructor(
    private schemaManager: SchemaManager,
    private connectionManager: RedisConnectionManager,
    private codec: CompressionCodec = NOOP_CODEC,
    // Pluggable (de)serializer. Defaults to the engine's lossless
    // tagged JSON serializer so callers don't have to opt in to get
    // correct `Date`/`BigInt`/`Map`/`Set` round-tripping. Passed in
    // by `RedisSchemaEngine` so reads and writes share one instance.
    private serializer: Serializer = TAGGED_SERIALIZER,
  ) {}

  /**
   * Normalize a complex nested entity into separate Redis keys
   */
  public async normalizeEntity(
    entityType: string,
    data: any,
    operationId: string = this.generateOperationId(),
  ): Promise<NormalizationResult> {
    const schema = this.schemaManager.getEntitySchema(entityType);
    const normalizedEntities = new Map<string, NormalizedEntity>();

    // Normalize the main entity and all nested entities
    await this.normalizeRecursive(
      entityType,
      data,
      normalizedEntities,
      operationId,
    );

    const entityId = data[schema.id];
    const primaryEntityKey = this.schemaManager.generateEntityKey(
      entityType,
      entityId,
    );

    return {
      normalizedEntities,
      primaryEntityKey,
      operationId,
    };
  }

  /**
   * Write normalized entities to Redis using a per-key compare-and-set so
   * concurrent writers cannot clobber each other's partial updates. The
   * caller-supplied entity-type lookup determines TTL per key.
   *
   * Flow per key:
   *   1. GET current value
   *   2. Merge in Node (preserves "missing fields keep existing" semantics)
   *   3. CAS write via Lua. If another writer raced us, retry up to
   *      `maxCasAttempts` times with the freshly read value.
   *
   * All keys are processed in parallel (Promise.all) and ioredis pipelines
   * them automatically across the same connection, so latency stays close
   * to the original implementation while gaining atomicity.
   */
  public async writeNormalizedEntities(
    normalizationResult: NormalizationResult,
    resolveTTL: (key: string) => number = () => 0,
  ): Promise<WriteResult> {
    const { normalizedEntities, operationId } = normalizationResult;
    const keys = Array.from(normalizedEntities.keys());

    try {
      await Promise.all(
        keys.map((key) =>
          this.atomicMergeWrite(
            key,
            normalizedEntities.get(key)!,
            resolveTTL(key),
          ),
        ),
      );

      return {
        success: true,
        keys,
        operationId,
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new RedisConnectionError(
        'Failed to write normalized entities',
        error as Error,
      );
    }
  }

  /**
   * Per-key compare-and-set merge with bounded retry. Each retry re-reads
   * the current value so the merge is always against the freshest view.
   * Surfaces a RedisConnectionError if the contention budget is exhausted,
   * which is the right behaviour: callers should retry at the request level
   * rather than spin forever inside a single write.
   */
  private async atomicMergeWrite(
    key: string,
    incoming: NormalizedEntity,
    ttlSeconds: number,
  ): Promise<void> {
    const maxCasAttempts = 5;
    for (let attempt = 1; attempt <= maxCasAttempts; attempt++) {
      // currentRaw is the literal bytes stored in Redis; it may be a
      // compressed envelope (`\x00z1:...base64...`) or plain JSON. We
      // pass it back to CAS as `expected` unchanged so byte equality
      // holds against whatever is actually stored.
      const currentRaw = await this.connectionManager.get(key);

      let merged: NormalizedEntity;
      if (currentRaw) {
        // Decode for the merge step only; the merge needs structured
        // data, not the storage envelope. Routing through the shared
        // serializer ensures previously stored Dates/BigInts/Maps/etc.
        // come back as their original JS types so smartMerge sees the
        // same structure the original writer wrote.
        let existing: NormalizedEntity | null = null;
        try {
          existing = this.serializer.parse(
            this.codec.decode(currentRaw),
          ) as NormalizedEntity;
        } catch {
          existing = null;
        }
        merged = existing ? this.smartMerge(existing, incoming) : incoming;
      } else {
        merged = incoming;
      }

      // Serialize through the configured serializer so non-JSON-native
      // values (Date, BigInt, Map, Set, RegExp, Buffer, NaN/Infinity)
      // are tagged for lossless recovery on read. Plain JSON-native
      // payloads still produce identical bytes to raw JSON.stringify.
      const newJson = this.serializer.stringify(merged);
      // Encode for storage. May or may not actually compress depending
      // on the codec config and payload size; either way the result is
      // a single string Redis stores verbatim.
      const newEncoded = this.codec.encode(newJson);
      const expected = currentRaw ?? '';
      const ok = await this.connectionManager.casSet(
        key,
        expected,
        newEncoded,
        ttlSeconds,
      );
      if (ok) return;
    }

    throw new RedisConnectionError(
      `CAS contention: failed to write '${key}' after retries`,
    );
  }

  /**
   * Recursively normalize entity and its relationships
   */
  private async normalizeRecursive(
    entityType: string,
    data: any,
    result: Map<string, NormalizedEntity>,
    operationId: string,
    visited: Set<string> = new Set(),
  ): Promise<void> {
    if (!data || typeof data !== 'object') {
      return;
    }

    const schema = this.schemaManager.getEntitySchema(entityType);
    const entityId = data[schema.id];

    if (!entityId) {
      throw new InvalidOperationError(
        'normalize',
        `Missing required ID field '${schema.id}' in entity '${entityType}'`,
        { entityType, data },
      );
    }

    const entityKey = this.schemaManager.generateEntityKey(
      entityType,
      entityId,
    );

    // Prevent infinite recursion
    const visitKey = `${entityType}:${entityId}`;
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);

    // Create normalized entity
    const normalizedEntity: NormalizedEntity = {};

    // Add metadata
    normalizedEntity[VERSION_FIELD] = schema.version || '1.0.0';
    normalizedEntity[TIMESTAMP_FIELD] = Date.now();
    normalizedEntity[METADATA_FIELD] = {
      entityType,
      originalId: entityId,
      relationshipIds: {},
      lastUpdated: Date.now(),
      source: operationId,
    };

    // Process regular fields
    if (schema.fields) {
      for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
        if (fieldName in data) {
          normalizedEntity[fieldName] = data[fieldName];
        }
      }
    }

    // Process relationships
    if (schema.relations) {
      for (const [relationName, relationDef] of Object.entries(
        schema.relations,
      )) {
        if (relationName in data) {
          await this.processRelationship(
            relationName,
            relationDef,
            data[relationName],
            normalizedEntity,
            result,
            operationId,
            visited,
          );
        }
      }
    }

    // Store normalized entity
    result.set(entityKey, normalizedEntity);
  }

  /**
   * Process a relationship and normalize related entities
   */
  private async processRelationship(
    relationName: string,
    relationDef: RelationDefinition,
    relationData: any,
    parentEntity: NormalizedEntity,
    result: Map<string, NormalizedEntity>,
    operationId: string,
    visited: Set<string>,
  ): Promise<void> {
    const relatedSchema = this.schemaManager.getEntitySchema(relationDef.type);
    const relationIdField = generateRelationIdField(
      relationName,
      relationDef.kind,
    );

    if (relationDef.kind === 'one') {
      // One-to-one relationship
      if (relationData && typeof relationData === 'object') {
        const relatedId = relationData[relatedSchema.id];
        if (relatedId) {
          parentEntity[relationIdField] = relatedId;

          // Store relationship ID in metadata
          const metadata = parentEntity[METADATA_FIELD] as EntityMetadata;
          metadata.relationshipIds[relationName] = relatedId;

          // Recursively normalize related entity
          await this.normalizeRecursive(
            relationDef.type,
            relationData,
            result,
            operationId,
            visited,
          );
        }
      }
    } else if (relationDef.kind === 'many') {
      // One-to-many relationship
      if (Array.isArray(relationData)) {
        const relatedIds: any[] = [];

        for (const relatedItem of relationData) {
          if (relatedItem && typeof relatedItem === 'object') {
            const relatedId = relatedItem[relatedSchema.id];
            if (relatedId) {
              relatedIds.push(relatedId);

              // Recursively normalize related entity
              await this.normalizeRecursive(
                relationDef.type,
                relatedItem,
                result,
                operationId,
                visited,
              );
            }
          }
        }

        if (relatedIds.length > 0) {
          parentEntity[relationIdField] = relatedIds;

          // Store relationship IDs in metadata
          const metadata = parentEntity[METADATA_FIELD] as EntityMetadata;
          metadata.relationshipIds[relationName] = relatedIds;
        }
      }
    }
  }

  /**
   * Smart merge strategy based on field types
   */
  private smartMerge(
    existingEntity: NormalizedEntity,
    newEntity: NormalizedEntity,
  ): NormalizedEntity {
    const merged: NormalizedEntity = { ...existingEntity };

    for (const [key, newValue] of Object.entries(newEntity)) {
      const existingValue = existingEntity[key];

      if (key.startsWith(INTERNAL_FIELD_PREFIX)) {
        // Always update internal fields
        merged[key] = newValue;
      } else if (this.isPrimitiveValue(newValue)) {
        // Primitive fields: replace with new value
        merged[key] = newValue;
      } else if (Array.isArray(newValue)) {
        // Array fields: replace entire array
        merged[key] = newValue;
      } else if (this.isObject(newValue) && this.isObject(existingValue)) {
        // Object fields: deep merge
        merged[key] = this.deepMergeObjects(existingValue, newValue);
      } else {
        // Default: replace with new value
        merged[key] = newValue;
      }
    }

    // Update timestamp
    merged[TIMESTAMP_FIELD] = Date.now();

    return merged;
  }

  /**
   * Check if value is primitive (string, number, boolean, null, undefined)
   */
  private isPrimitiveValue(value: any): boolean {
    return (
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    );
  }

  /**
   * Check if value is a plain object
   */
  private isObject(value: any): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.constructor === Object
    );
  }

  /**
   * Deep merge two objects
   */
  private deepMergeObjects(existing: any, incoming: any): any {
    const result = { ...existing };

    for (const [key, value] of Object.entries(incoming)) {
      const existingValue = existing[key];

      if (this.isObject(value) && this.isObject(existingValue)) {
        result[key] = this.deepMergeObjects(existingValue, value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

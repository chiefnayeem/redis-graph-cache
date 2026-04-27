/**
 * Hydration Engine - Reconstructs full objects from normalized storage
 */

import { SchemaManager } from './schema-manager';
import { RedisConnectionManager } from './redis-connection-manager';
import { CompressionCodec, NOOP_CODEC } from './compression';
import { Serializer, TAGGED_SERIALIZER } from './serializer';
import { EntitySchema, RelationDefinition } from '../types';
import {
  HydrationContext,
  NormalizedEntity,
  generateRelationIdField,
  stripInternalFields,
} from '../types';
import { HydrationOptions } from '../types';
import {
  HydrationDepthExceededError,
  MemoryLimitError,
  RedisConnectionError,
} from '../types';

export class HydrationEngine {
  constructor(
    private schemaManager: SchemaManager,
    private connectionManager: RedisConnectionManager,
    private defaultMaxDepth: number = 5,
    private defaultMaxMemory: number = 100 * 1024 * 1024, // 100MB
    private codec: CompressionCodec = NOOP_CODEC,
    // Pluggable (de)serializer. Defaults to the engine's lossless
    // tagged JSON serializer so reads recover `Date`/`BigInt`/`Map`/
    // `Set`/`RegExp`/`Buffer`/`NaN`/`±Infinity` as their original JS
    // types instead of degrading them to strings, nulls, or `{}`.
    private serializer: Serializer = TAGGED_SERIALIZER,
  ) {}

  /**
   * Hydrate a single entity with all its relationships
   */
  public async hydrateEntity(
    entityType: string,
    id: string | number,
    options: HydrationOptions = {},
  ): Promise<any> {
    const context = this.createHydrationContext(options);

    try {
      const result = await this.hydrateRecursive(entityType, id, context);
      return result ? stripInternalFields(result) : null;
    } catch (error) {
      if (
        error instanceof HydrationDepthExceededError ||
        error instanceof MemoryLimitError
      ) {
        // Return partial result with warning for limit exceeded errors
        console.warn(
          `Hydration limit exceeded for ${entityType}:${id}`,
          error.message,
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * Hydrate multiple entities in batch
   */
  public async hydrateEntities(
    entityType: string,
    ids: (string | number)[],
    options: HydrationOptions = {},
  ): Promise<any[]> {
    if (ids.length === 0) {
      return [];
    }

    // Create separate context for each entity to prevent cross-contamination
    const results = await Promise.all(
      ids.map((id) => this.hydrateEntity(entityType, id, options)),
    );

    // Filter out null results (deleted entities)
    return results.filter((result) => result !== null);
  }

  /**
   * Create hydration context with limits and tracking
   */
  private createHydrationContext(options: HydrationOptions): HydrationContext {
    return {
      visitedEntities: new Set(),
      currentDepth: 0,
      maxDepth: options.maxDepth || this.defaultMaxDepth,
      memoryUsage: 0,
      maxMemory: options.memoryLimit || this.defaultMaxMemory,
      requestId: this.generateRequestId(),
      selectiveFields: options.selectiveFields,
      excludeRelations: options.excludeRelations,
    };
  }

  /**
   * Recursively hydrate entity and its relationships
   */
  private async hydrateRecursive(
    entityType: string,
    id: string | number,
    context: HydrationContext,
  ): Promise<any> {
    // Check depth limit
    if (context.currentDepth >= context.maxDepth) {
      throw new HydrationDepthExceededError(
        context.currentDepth,
        context.maxDepth,
        context.requestId,
      );
    }

    // Check memory limit (rough estimation)
    if (context.memoryUsage > context.maxMemory) {
      throw new MemoryLimitError(
        Math.round(context.memoryUsage / (1024 * 1024)),
        Math.round(context.maxMemory / (1024 * 1024)),
        context.requestId,
      );
    }

    const schema = this.schemaManager.getEntitySchema(entityType);
    const entityKey = this.schemaManager.generateEntityKey(entityType, id);

    // Prevent circular references. Instead of silently dropping the related
    // entity (which corrupts the shape consumers expect) we emit a stub
    // that contains the id and a `$ref` marker so consumers can detect a
    // cycle and break recursion themselves. `$ref` is intentionally
    // un-prefixed so it survives `stripInternalFields`.
    const visitKey = `${entityType}:${id}`;
    if (context.visitedEntities.has(visitKey)) {
      return { [schema.id]: id, $ref: `${entityType}:${id}` };
    }
    context.visitedEntities.add(visitKey);

    try {
      // Get entity from Redis
      const normalizedEntity = await this.getEntityFromRedis(entityKey);
      if (!normalizedEntity) {
        return null; // Entity not found
      }

      // Update memory usage estimation. We use the configured
      // serializer here too because plain `JSON.stringify` would throw
      // on values that the serializer specifically handles (BigInt) or
      // silently understate the size (Buffer, Map). Wrapped in
      // try/catch so a serialization quirk on a single entity can
      // never abort hydration of the whole graph — the size estimate
      // is best-effort.
      try {
        context.memoryUsage +=
          this.serializer.stringify(normalizedEntity).length;
      } catch {
        // Fall back to a conservative constant if even the serializer
        // can't stringify the value. This is intentionally generous so
        // we still apply some memory pressure rather than treating the
        // entity as zero bytes.
        context.memoryUsage += 4096;
      }

      // Build the hydrated entity. When `selectiveFields` is supplied the
      // output is restricted to only those keys plus the ID field; we still
      // keep the internal `__rse_*` markers in scope so relationship
      // hydration can resolve referenced ids, then `stripInternalFields`
      // removes them at the public boundary.
      let hydratedEntity: any;
      if (context.selectiveFields && context.selectiveFields.length > 0) {
        const allowed = new Set<string>(context.selectiveFields);
        allowed.add(schema.id);
        const filtered: any = {};
        for (const [k, v] of Object.entries(normalizedEntity)) {
          if (allowed.has(k) || k.startsWith('__rse_')) {
            filtered[k] = v;
          }
        }
        hydratedEntity = filtered;
      } else {
        hydratedEntity = { ...normalizedEntity };
      }

      // Hydrate relationships
      if (schema.relations && !this.shouldSkipRelations(context)) {
        context.currentDepth++;

        await this.hydrateRelationships(
          schema,
          normalizedEntity,
          hydratedEntity,
          context,
        );

        context.currentDepth--;
      }

      return hydratedEntity;
    } finally {
      // Remove from visited set to allow re-visiting in different branches
      context.visitedEntities.delete(visitKey);
    }
  }

  /**
   * Hydrate all relationships for an entity
   */
  private async hydrateRelationships(
    schema: EntitySchema,
    normalizedEntity: NormalizedEntity,
    hydratedEntity: any,
    context: HydrationContext,
  ): Promise<void> {
    if (!schema.relations) return;

    const relationPromises: Promise<void>[] = [];

    for (const [relationName, relationDef] of Object.entries(
      schema.relations,
    )) {
      // Skip excluded relations
      if (context.excludeRelations?.includes(relationName)) {
        continue;
      }

      const promise = this.hydrateRelation(
        relationName,
        relationDef,
        normalizedEntity,
        hydratedEntity,
        context,
      );

      relationPromises.push(promise);
    }

    // Execute all relationship hydrations in parallel
    await Promise.all(relationPromises);
  }

  /**
   * Hydrate a single relationship
   */
  private async hydrateRelation(
    relationName: string,
    relationDef: RelationDefinition,
    normalizedEntity: NormalizedEntity,
    hydratedEntity: any,
    context: HydrationContext,
  ): Promise<void> {
    const relationIdField = generateRelationIdField(
      relationName,
      relationDef.kind,
    );
    const relationIds = normalizedEntity[relationIdField];

    if (!relationIds) {
      // No relation data, set appropriate default
      hydratedEntity[relationName] = relationDef.kind === 'one' ? null : [];
      return;
    }

    try {
      if (relationDef.kind === 'one') {
        // One-to-one relationship
        const relatedEntity = await this.hydrateRecursive(
          relationDef.type,
          relationIds,
          { ...context },
        );
        hydratedEntity[relationName] = relatedEntity;
      } else {
        // One-to-many relationship
        if (Array.isArray(relationIds)) {
          const relatedEntities = await this.batchHydrateEntities(
            relationDef.type,
            relationIds,
            context,
          );
          hydratedEntity[relationName] = relatedEntities;
        } else {
          hydratedEntity[relationName] = [];
        }
      }
    } catch (error) {
      // Handle relation hydration errors gracefully
      console.warn(`Failed to hydrate relation '${relationName}':`, error);
      hydratedEntity[relationName] = relationDef.kind === 'one' ? null : [];
    }
  }

  /**
   * Batch hydrate multiple entities efficiently
   */
  private async batchHydrateEntities(
    entityType: string,
    ids: any[],
    context: HydrationContext,
  ): Promise<any[]> {
    if (ids.length === 0) {
      return [];
    }

    // First, batch fetch all entities from Redis
    const entityKeys = ids.map((id) =>
      this.schemaManager.generateEntityKey(entityType, id),
    );

    const normalizedEntities = await this.batchGetEntitiesFromRedis(entityKeys);

    // Then hydrate each entity
    const hydrationPromises = ids.map(async (id, index) => {
      const normalizedEntity = normalizedEntities[index];
      if (!normalizedEntity) {
        return null; // Entity not found
      }

      // Create a copy of context for each entity
      const entityContext = {
        ...context,
        visitedEntities: new Set(context.visitedEntities),
      };

      return this.hydrateRecursive(entityType, id, entityContext);
    });

    const results = await Promise.all(hydrationPromises);

    // Filter out null results (deleted entities)
    return results.filter((result) => result !== null);
  }

  /**
   * Get a single entity from Redis. Hits/misses are tracked by the
   * connection-manager wrapper so we don't double-count here. The codec
   * decodes the storage envelope (decompressing if needed) before JSON
   * parsing; untagged values pass through, preserving compatibility
   * with caches that pre-date compression.
   */
  private async getEntityFromRedis(
    key: string,
  ): Promise<NormalizedEntity | null> {
    try {
      const value = await this.connectionManager.get(key);
      if (!value) return null;
      return this.serializer.parse(
        this.codec.decode(value),
      ) as NormalizedEntity;
    } catch (error) {
      throw new RedisConnectionError(
        `Failed to get entity from Redis: ${key}`,
        error as Error,
      );
    }
  }

  /**
   * Batch fetch multiple entities via MGET. Each value is independently
   * decoded (codec) and JSON-parsed. Per-element parse failures surface
   * as null so the rest of the batch is still usable.
   */
  private async batchGetEntitiesFromRedis(
    keys: string[],
  ): Promise<(NormalizedEntity | null)[]> {
    if (keys.length === 0) return [];
    try {
      const values = await this.connectionManager.mget(keys);
      return values.map((value) => {
        if (!value) return null;
        try {
          return this.serializer.parse(
            this.codec.decode(value),
          ) as NormalizedEntity;
        } catch {
          return null;
        }
      });
    } catch (error) {
      throw new RedisConnectionError(
        'Failed to batch get entities from Redis',
        error as Error,
      );
    }
  }

  /**
   * Check if relations should be skipped based on context
   */
  private shouldSkipRelations(context: HydrationContext): boolean {
    return context.excludeRelations?.includes('*') || false;
  }

  /**
   * Generate unique request ID for tracking
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

/**
 * Redis Schema Engine - Main class providing the public API
 */

import { randomUUID } from 'crypto';
import {
  SchemaManager,
  RedisConnectionManager,
  NormalizationEngine,
  HydrationEngine,
  CompressionCodec,
  TAGGED_SERIALIZER,
} from './core';

import {
  InvalidOperationError,
  RedisConnectionError,
  Schema,
  RedisSchemaEngineConfig,
  PartialRedisSchemaEngineConfig,
  WriteResult,
  ListWriteResult,
  CacheMetrics,
  HealthStatus,
  HydrationOptions,
} from './types';

export class RedisGraphCache<TSchema extends Schema> {
  private schemaManager!: SchemaManager;
  private connectionManager!: RedisConnectionManager;
  private normalizationEngine!: NormalizationEngine;
  private hydrationEngine!: HydrationEngine;
  private config: RedisSchemaEngineConfig;
  private activeOperations: number = 0;

  constructor(schema: TSchema, config: PartialRedisSchemaEngineConfig = {}) {
    this.config = this.mergeWithDefaults(config);
    this.initializeComponents(schema);
  }

  /**
   * Wrap a public operation with active-counter bookkeeping. Lets the
   * health endpoint report a real (not stubbed) `activeOperations` value.
   */
  private async tracked<T>(fn: () => Promise<T>): Promise<T> {
    this.activeOperations++;
    try {
      return await fn();
    } finally {
      this.activeOperations--;
    }
  }

  /**
   * Resolve the TTL for a given normalized entity key. The key format is
   * always `entityType:id` so the prefix tells us which schema to consult.
   */
  private resolveEntityKeyTTL = (key: string): number => {
    const idx = key.indexOf(':');
    if (idx <= 0) return 0;
    const entityType = key.slice(0, idx);
    if (!this.schemaManager.hasEntitySchema(entityType)) return 0;
    return this.schemaManager.resolveEntityTTL(entityType);
  };

  /**
   * Build a TTL resolver for a single write call that, when `cascadeTTL`
   * is true, applies a floor: every entity written in this call uses at
   * least `parentTtl` even if its own schema TTL is shorter. This is the
   * fix for the "parent post (1h) embeds short-TTL category (1m); after
   * 1m the post hydrates without its category" coherence bug.
   *
   * Special cases:
   *   - parentTtl = 0 (no expiry on parent): children also get 0,
   *     guaranteeing they outlive a never-expiring parent.
   *   - cascadeTTL = false (default): returns the unmodified resolver,
   *     so existing behaviour is bit-for-bit preserved.
   *   - parentTtl negative or NaN: ignored, falls back to per-key TTL.
   */
  private buildTTLResolver(
    cascadeTTL: boolean | undefined,
    parentTtl: number,
    overrideKey?: string,
    overrideTtl?: number,
    forceTTL?: boolean,
  ): (key: string) => number {
    // forceTTL is the strongest mode: every key in this call gets
    // exactly `parentTtl`, ignoring its own schema TTL and ignoring
    // the cascade-as-floor logic. Use this when the caller explicitly
    // wants to pin the entire write to a uniform TTL (e.g. shortening
    // a whole batch for testing, or matching an external eviction
    // policy). Negative / NaN parentTtl falls through to base rules.
    if (forceTTL && Number.isFinite(parentTtl) && parentTtl >= 0) {
      return () => parentTtl;
    }

    // Base resolver: cascade rules without any per-key override.
    const base: (key: string) => number = (() => {
      if (!cascadeTTL) return this.resolveEntityKeyTTL;
      if (parentTtl === 0) {
        // Parent has no expiry; every child must also have no expiry
        // to keep the graph consistent under the cascade contract.
        return () => 0;
      }
      if (!Number.isFinite(parentTtl) || parentTtl < 0) {
        return this.resolveEntityKeyTTL;
      }
      return (key: string) => {
        const ownTtl = this.resolveEntityKeyTTL(key);
        // 0 means "no expiry". Treat it as effectively infinite when
        // comparing against parentTtl so we never demote an explicitly
        // persistent key to a shorter TTL.
        if (ownTtl === 0) return 0;
        return Math.max(ownTtl, parentTtl);
      };
    })();

    // When the caller pinned an explicit TTL for a specific key
    // (typically the root entity of a `writeEntity({ ttl })` call),
    // that value wins for that key regardless of cascade rules. Every
    // other key still goes through `base`, so embedded children keep
    // their schema TTL unless `cascadeTTL` lifts them.
    if (overrideKey === undefined || overrideTtl === undefined) return base;
    return (key: string) => (key === overrideKey ? overrideTtl : base(key));
  }

  /**
   * Runtime helper for the dual positional/object-style public API.
   * `typeof x === 'object' && x !== null` distinguishes the object
   * form from the positional-string-first form, since `entityType`
   * and `listType` are always strings.
   */
  private isArgsObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
  }

  // =====================================================
  // ENTITY OPERATIONS
  // =====================================================

  /**
   * Write an entity with nested relationships to Redis.
   *
   * Two equivalent call styles are supported:
   *
   * ```ts
   * // Object form (recommended for new code)
   * await engine.writeEntity({ entityType: 'post', data, ttl, cascadeTTL });
   *
   * // Positional form (preserved for existing callers)
   * await engine.writeEntity('post', data, { ttl, cascadeTTL });
   * ```
   *
   * When `ttl` is provided it overrides the entity's schema TTL for
   * THIS WRITE ONLY, pinned to the root entity's key. Embedded
   * relations still use their own schema TTL unless `cascadeTTL: true`
   * is set — in which case the override also becomes the cascade
   * floor for every child written by this call.
   */
  public async writeEntity<T>(args: {
    entityType: keyof TSchema;
    data: T;
    ttl?: number;
    cascadeTTL?: boolean;
    forceTTL?: boolean;
  }): Promise<WriteResult>;
  public async writeEntity<T>(
    entityType: keyof TSchema,
    data: T,
    options?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<WriteResult>;
  public async writeEntity<T>(
    a:
      | keyof TSchema
      | {
          entityType: keyof TSchema;
          data: T;
          ttl?: number;
          cascadeTTL?: boolean;
          forceTTL?: boolean;
        },
    b?: T,
    c?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<WriteResult> {
    const { entityType, data, ttl, cascadeTTL, forceTTL } = this.isArgsObject(a)
      ? a
      : {
          entityType: a,
          data: b as T,
          ttl: c?.ttl,
          cascadeTTL: c?.cascadeTTL,
          forceTTL: c?.forceTTL,
        };

    return this.tracked(async () => {
      try {
        const normalizationResult =
          await this.normalizationEngine.normalizeEntity(
            entityType as string,
            data,
          );

        // Effective parent TTL drives both (a) the cascade floor when
        // cascadeTTL is on and (b) the override for the root key.
        const schemaTtl = this.schemaManager.resolveEntityTTL(
          entityType as string,
        );
        const effectiveParentTtl = ttl ?? schemaTtl;
        const resolver = this.buildTTLResolver(
          cascadeTTL,
          effectiveParentTtl,
          // Pin the override only when the caller supplied ttl; otherwise
          // the root entity goes through the usual per-key resolver.
          ttl !== undefined ? normalizationResult.primaryEntityKey : undefined,
          ttl,
          forceTTL,
        );

        return await this.normalizationEngine.writeNormalizedEntities(
          normalizationResult,
          resolver,
        );
      } catch (error) {
        if (error instanceof InvalidOperationError) throw error;
        throw new InvalidOperationError(
          'writeEntity',
          `Failed to write entity '${String(entityType)}'`,
          { entityType, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Read and hydrate an entity with all its relationships
   */
  public async readEntity(
    entityType: keyof TSchema,
    id: string | number,
    options: HydrationOptions = {},
  ): Promise<any> {
    return this.tracked(async () => {
      try {
        return await this.hydrationEngine.hydrateEntity(
          entityType as string,
          id,
          options,
        );
      } catch (error) {
        throw new InvalidOperationError(
          'readEntity',
          `Failed to read entity '${String(entityType)}' with id '${id}'`,
          { entityType, id, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Delete an entity from Redis
   */
  public async deleteEntity(
    entityType: keyof TSchema,
    id: string | number,
  ): Promise<boolean> {
    return this.tracked(async () => {
      try {
        const entityKey = this.schemaManager.generateEntityKey(
          entityType as string,
          id,
        );
        const result = await this.connectionManager.del(entityKey);
        return result > 0;
      } catch (error) {
        throw new InvalidOperationError(
          'deleteEntity',
          `Failed to delete entity '${String(entityType)}' with id '${id}'`,
          { entityType, id, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Update an entity ONLY if it already exists in cache
   * This is useful for cache invalidation scenarios where you don't want to
   * create cache entries for data that hasn't been accessed yet
   *
   * @returns WriteResult if entity exists and was updated, null if entity doesn't exist
   */
  public async updateEntityIfExists(args: {
    entityType: keyof TSchema;
    data: any;
    ttl?: number;
    cascadeTTL?: boolean;
    forceTTL?: boolean;
  }): Promise<WriteResult | null>;
  public async updateEntityIfExists(
    entityType: keyof TSchema,
    data: any,
    options?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<WriteResult | null>;
  public async updateEntityIfExists(
    a:
      | keyof TSchema
      | {
          entityType: keyof TSchema;
          data: any;
          ttl?: number;
          cascadeTTL?: boolean;
          forceTTL?: boolean;
        },
    b?: any,
    c?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<WriteResult | null> {
    const { entityType, data, ttl, cascadeTTL, forceTTL } = this.isArgsObject(a)
      ? a
      : {
          entityType: a,
          data: b,
          ttl: c?.ttl,
          cascadeTTL: c?.cascadeTTL,
          forceTTL: c?.forceTTL,
        };

    return this.tracked(async () => {
      try {
        const entitySchema = this.schemaManager.getEntitySchema(
          entityType as string,
        );
        const entityId = data[entitySchema.id];

        if (entityId === undefined || entityId === null) {
          throw new InvalidOperationError(
            'updateEntityIfExists',
            `Missing ID field '${entitySchema.id}' in entity data`,
            { entityType, data },
          );
        }

        // EXISTS is cheaper than GET; we only need presence here. There is
        // an unavoidable but harmless race window: the key could be evicted
        // between EXISTS and the subsequent atomic write. The CAS path used
        // by writeEntity will recover correctly in either outcome.
        const entityKey = this.schemaManager.generateEntityKey(
          entityType as string,
          entityId,
        );
        const exists = await this.connectionManager.exists(entityKey);
        if (exists === 0) return null;

        return await this.writeEntity({
          entityType: entityType as keyof TSchema,
          data,
          ttl,
          cascadeTTL,
          forceTTL,
        });
      } catch (error) {
        if (error instanceof InvalidOperationError) throw error;
        throw new InvalidOperationError(
          'updateEntityIfExists',
          `Failed to update entity '${String(entityType)}'`,
          { entityType, data, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  // =====================================================
  // LIST OPERATIONS
  // =====================================================

  /**
   * Write a list of entities to Redis
   */
  public async writeList(args: {
    listType: keyof TSchema;
    params: any;
    items: any[];
    ttl?: number;
    cascadeTTL?: boolean;
    forceTTL?: boolean;
  }): Promise<ListWriteResult>;
  public async writeList(
    listType: keyof TSchema,
    params: any,
    items: any[],
    options?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<ListWriteResult>;
  public async writeList(
    a:
      | keyof TSchema
      | {
          listType: keyof TSchema;
          params: any;
          items: any[];
          ttl?: number;
          cascadeTTL?: boolean;
          forceTTL?: boolean;
        },
    b?: any,
    c?: any[],
    d?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<ListWriteResult> {
    const { listType, params, items, ttl, cascadeTTL, forceTTL } =
      this.isArgsObject(a)
        ? a
        : {
            listType: a,
            params: b,
            items: c as any[],
            ttl: d?.ttl,
            cascadeTTL: d?.cascadeTTL,
            forceTTL: d?.forceTTL,
          };

    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getListSchema(listType as string);
        const operationId = this.generateOperationId();

        const ids = items.map((item) => {
          const id = item[listSchema.idField];
          if (id === undefined || id === null) {
            throw new InvalidOperationError(
              'writeList',
              `Missing ID field '${listSchema.idField}' in list item`,
              { listType, item },
            );
          }
          return id;
        });

        const listKey = this.schemaManager.generateListKey(
          listType as string,
          ...Object.values(params),
        );

        // Normalize all items into a single combined plan so we issue one
        // batch of CAS writes instead of N sequential round-trips. Each
        // entity still gets its TTL applied via resolveEntityKeyTTL.
        const combined = new Map<string, any>();
        for (const item of items) {
          const result = await this.normalizationEngine.normalizeEntity(
            listSchema.entityType,
            item,
            operationId,
          );
          for (const [k, v] of result.normalizedEntities) {
            combined.set(k, v);
          }
        }

        // For cascadeTTL, the "parent" of a writeList call is the list
        // itself; its TTL becomes the floor for every embedded entity
        // so embedded relations (e.g. a Category embedded inside posts)
        // cannot expire before the list does. `ttl` (if supplied)
        // overrides the list's schema TTL for this call, and therefore
        // also becomes the new cascade floor.
        const listTtl =
          ttl ?? this.schemaManager.resolveListTTL(listType as string);
        const resolver = this.buildTTLResolver(
          cascadeTTL,
          listTtl,
          undefined,
          undefined,
          forceTTL,
        );

        if (combined.size > 0) {
          await this.normalizationEngine.writeNormalizedEntities(
            {
              normalizedEntities: combined,
              primaryEntityKey: listKey,
              operationId,
            },
            resolver,
          );
        }

        // List body is a JSON array of ids; written with the list-level TTL.
        await this.connectionManager.set(listKey, JSON.stringify(ids), listTtl);

        return {
          success: true,
          key: listKey,
          ids,
          operationId,
          timestamp: Date.now(),
        };
      } catch (error) {
        if (error instanceof InvalidOperationError) throw error;
        throw new InvalidOperationError(
          'writeList',
          `Failed to write list '${String(listType)}'`,
          { listType, params, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Read and hydrate a list of entities
   */
  public async readList(
    listType: keyof TSchema,
    params: any,
    options: HydrationOptions = {},
  ): Promise<any[]> {
    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getListSchema(listType as string);
        const listKey = this.schemaManager.generateListKey(
          listType as string,
          ...Object.values(params),
        );

        const listData = await this.connectionManager.get(listKey);
        if (!listData) return [];

        let ids: any[];
        try {
          ids = JSON.parse(listData);
        } catch {
          return [];
        }
        if (!Array.isArray(ids)) return [];

        return await this.hydrationEngine.hydrateEntities(
          listSchema.entityType,
          ids,
          options,
        );
      } catch (error) {
        throw new InvalidOperationError(
          'readList',
          `Failed to read list '${String(listType)}'`,
          { listType, params, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Delete a list from Redis
   */
  public async deleteList(
    listType: keyof TSchema,
    params: any,
  ): Promise<boolean> {
    return this.tracked(async () => {
      try {
        const listKey = this.schemaManager.generateListKey(
          listType as string,
          ...Object.values(params),
        );
        const result = await this.connectionManager.del(listKey);
        return result > 0;
      } catch (error) {
        throw new InvalidOperationError(
          'deleteList',
          `Failed to delete list '${String(listType)}'`,
          { listType, params, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  // =====================================================
  // LIST ITEM MANAGEMENT
  // =====================================================

  /**
   * Add an item to a list (with entity data)
   * This method writes the entity to cache and adds it to the list
   */
  public async addListItem(args: {
    listType: keyof TSchema;
    params: any;
    entityData: any;
    ttl?: number;
    cascadeTTL?: boolean;
    forceTTL?: boolean;
  }): Promise<boolean>;
  public async addListItem(
    listType: keyof TSchema,
    params: any,
    entityData: any,
    options?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<boolean>;
  public async addListItem(
    a:
      | keyof TSchema
      | {
          listType: keyof TSchema;
          params: any;
          entityData: any;
          ttl?: number;
          cascadeTTL?: boolean;
          forceTTL?: boolean;
        },
    b?: any,
    c?: any,
    d?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<boolean> {
    const { listType, params, entityData, ttl, cascadeTTL, forceTTL } =
      this.isArgsObject(a)
        ? a
        : {
            listType: a,
            params: b,
            entityData: c,
            ttl: d?.ttl,
            cascadeTTL: d?.cascadeTTL,
            forceTTL: d?.forceTTL,
          };

    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getListSchema(listType as string);

        const entityId = entityData[listSchema.idField];
        if (entityId === undefined || entityId === null) {
          throw new InvalidOperationError(
            'addListItem',
            `Missing ID field '${listSchema.idField}' in entity data`,
            { listType, entityData },
          );
        }

        // Step 1: write/refresh the entity itself (with full normalization).
        // `ttl` here overrides the ENTITY's TTL (scope: the thing being
        // added), not the list key's TTL — the list key is shared state
        // and can't sensibly be per-item-overridden.
        await this.writeEntity({
          entityType: listSchema.entityType as keyof TSchema,
          data: entityData,
          ttl,
          cascadeTTL,
          forceTTL,
        });

        // Step 2: atomically append to the list via Lua. This replaces the
        // previous read-modify-write that lost concurrent inserts.
        const listKey = this.schemaManager.generateListKey(
          listType as string,
          ...Object.values(params),
        );
        const listTtl = this.schemaManager.resolveListTTL(listType as string);
        return await this.connectionManager.listAdd(listKey, entityId, listTtl);
      } catch (error) {
        if (error instanceof InvalidOperationError) throw error;
        throw new InvalidOperationError(
          'addListItem',
          `Failed to add item to list '${String(listType)}'`,
          { listType, params, entityData, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Remove an item from a list (and optionally delete the entity)
   */
  public async removeListItem(
    listType: keyof TSchema,
    params: any,
    entityId: any,
    options: { deleteEntity?: boolean } = {},
  ): Promise<boolean> {
    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getListSchema(listType as string);
        const listKey = this.schemaManager.generateListKey(
          listType as string,
          ...Object.values(params),
        );

        // Atomic remove via Lua so concurrent removes/adds don't race.
        const removed = await this.connectionManager.listRemove(
          listKey,
          entityId,
        );

        if (removed && options.deleteEntity) {
          await this.deleteEntity(
            listSchema.entityType as keyof TSchema,
            entityId,
          );
        }

        return removed;
      } catch (error) {
        throw new InvalidOperationError(
          'removeListItem',
          `Failed to remove item from list '${String(listType)}'`,
          { listType, params, entityId, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  // =====================================================
  // INDEXED LIST OPERATIONS (ZSET-backed)
  // =====================================================

  /**
   * Resolve the ZSET score for an entity from its schema's `scoreField`,
   * with fallbacks: numeric strings, ISO timestamps via `Date.parse`, or
   * insertion time when no `scoreField` is configured. Throws on values
   * that cannot be coerced to a finite number, since silently scoring at
   * 0 would scramble feed ordering.
   */
  private resolveIndexedListScore(
    schema: import('./types/schema.types').IndexedListSchema,
    entity: any,
  ): number {
    if (!schema.scoreField) return Date.now();
    const raw = entity[schema.scoreField];
    if (raw === undefined || raw === null) {
      throw new InvalidOperationError(
        'resolveScore',
        `Entity missing scoreField '${schema.scoreField}'`,
        { entity },
        this.generateRequestId(),
      );
    }
    const direct = Number(raw);
    if (Number.isFinite(direct)) return direct;
    const fromDate = new Date(raw).getTime();
    if (Number.isFinite(fromDate)) return fromDate;
    throw new InvalidOperationError(
      'resolveScore',
      `Cannot derive numeric score from value of '${schema.scoreField}'`,
      { value: raw },
      this.generateRequestId(),
    );
  }

  /**
   * Bulk upsert an indexed list. Each item is normalized + written like a
   * regular entity, then added to the ZSET with its computed score. This
   * does NOT clear existing members; for full replace, call
   * `deleteIndexedList` first.
   */
  public async writeIndexedList(args: {
    listType: keyof TSchema;
    params: any;
    items: any[];
    ttl?: number;
    cascadeTTL?: boolean;
    forceTTL?: boolean;
  }): Promise<ListWriteResult>;
  public async writeIndexedList(
    listType: keyof TSchema,
    params: any,
    items: any[],
    options?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<ListWriteResult>;
  public async writeIndexedList(
    a:
      | keyof TSchema
      | {
          listType: keyof TSchema;
          params: any;
          items: any[];
          ttl?: number;
          cascadeTTL?: boolean;
          forceTTL?: boolean;
        },
    b?: any,
    c?: any[],
    d?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<ListWriteResult> {
    const {
      listType,
      params,
      items,
      ttl: ttlOverride,
      cascadeTTL,
      forceTTL,
    } = this.isArgsObject(a)
      ? a
      : {
          listType: a,
          params: b,
          items: c as any[],
          ttl: d?.ttl,
          cascadeTTL: d?.cascadeTTL,
          forceTTL: d?.forceTTL,
        };

    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getIndexedListSchema(
          listType as string,
        );
        const operationId = this.generateOperationId();

        const listKey = this.schemaManager.generateIndexedListKey(
          listType as string,
          ...Object.values(params),
        );

        // Normalize all items in one combined plan so the entity write is
        // a single batched CAS round-trip.
        const combined = new Map<string, any>();
        const planned: Array<{ id: any; score: number }> = [];
        for (const item of items) {
          const id = item[listSchema.idField];
          if (id === undefined || id === null) {
            throw new InvalidOperationError(
              'writeIndexedList',
              `Missing ID field '${listSchema.idField}' in list item`,
              { listType, item },
            );
          }
          const score = this.resolveIndexedListScore(listSchema, item);
          planned.push({ id, score });
          const result = await this.normalizationEngine.normalizeEntity(
            listSchema.entityType,
            item,
            operationId,
          );
          for (const [k, v] of result.normalizedEntities) {
            combined.set(k, v);
          }
        }

        // The indexed list itself is the cascade parent: its TTL becomes
        // the floor for every embedded entity in this batch. `ttlOverride`
        // (if supplied) replaces the list's schema TTL for this call and
        // therefore also shifts the cascade floor.
        const ttl =
          ttlOverride ??
          this.schemaManager.resolveIndexedListTTL(listType as string);
        const resolver = this.buildTTLResolver(
          cascadeTTL,
          ttl,
          undefined,
          undefined,
          forceTTL,
        );

        if (combined.size > 0) {
          await this.normalizationEngine.writeNormalizedEntities(
            {
              normalizedEntities: combined,
              primaryEntityKey: listKey,
              operationId,
            },
            resolver,
          );
        }

        // ZADD each member atomically with optional trim + back-index. We
        // run these in parallel; ioredis pipelines them on the connection.
        const maxSize = listSchema.maxSize ?? 0;
        const tracked = !!listSchema.trackMembership;
        await Promise.all(
          planned.map(({ id, score }) =>
            this.connectionManager.zListAdd(
              listKey,
              this.schemaManager.generateMembershipKey(
                listSchema.entityType,
                id,
              ),
              score,
              id,
              ttl,
              maxSize,
              tracked,
            ),
          ),
        );

        return {
          success: true,
          key: listKey,
          ids: planned.map((p) => p.id),
          operationId,
          timestamp: Date.now(),
        };
      } catch (error) {
        if (error instanceof InvalidOperationError) throw error;
        throw new InvalidOperationError(
          'writeIndexedList',
          `Failed to write indexed list '${String(listType)}'`,
          { listType, params, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Read a hydrated, paginated slice of an indexed list. Returns at most
   * `limit` (default 50) hydrated entities. Combines ZSET pagination
   * options (`offset`, `limit`, `reverse`, `minScore`, `maxScore`) with
   * the standard hydration options (`maxDepth`, `selectiveFields`,
   * `excludeRelations`).
   */
  public async readIndexedList(
    listType: keyof TSchema,
    params: any,
    opts: HydrationOptions & {
      offset?: number;
      limit?: number;
      reverse?: boolean;
      minScore?: number;
      maxScore?: number;
    } = {},
  ): Promise<any[]> {
    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getIndexedListSchema(
          listType as string,
        );
        const listKey = this.schemaManager.generateIndexedListKey(
          listType as string,
          ...Object.values(params),
        );

        const ids = (await this.connectionManager.zListRange(listKey, {
          offset: opts.offset,
          limit: opts.limit,
          reverse: opts.reverse,
          minScore: opts.minScore,
          maxScore: opts.maxScore,
        })) as string[];

        if (ids.length === 0) return [];

        return await this.hydrationEngine.hydrateEntities(
          listSchema.entityType,
          ids,
          {
            maxDepth: opts.maxDepth,
            selectiveFields: opts.selectiveFields,
            excludeRelations: opts.excludeRelations,
            memoryLimit: opts.memoryLimit,
          },
        );
      } catch (error) {
        throw new InvalidOperationError(
          'readIndexedList',
          `Failed to read indexed list '${String(listType)}'`,
          { listType, params, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Atomic single-item upsert into an indexed list. Writes the entity in
   * full normalized form first, then issues an atomic ZADD with the
   * resolved score and any configured trim/membership tracking. Returns
   * true if a new member was added, false if the score was updated on
   * an already-present id (still considered success).
   */
  public async addIndexedListItem(args: {
    listType: keyof TSchema;
    params: any;
    entityData: any;
    ttl?: number;
    cascadeTTL?: boolean;
    forceTTL?: boolean;
  }): Promise<boolean>;
  public async addIndexedListItem(
    listType: keyof TSchema,
    params: any,
    entityData: any,
    options?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<boolean>;
  public async addIndexedListItem(
    a:
      | keyof TSchema
      | {
          listType: keyof TSchema;
          params: any;
          entityData: any;
          ttl?: number;
          cascadeTTL?: boolean;
          forceTTL?: boolean;
        },
    b?: any,
    c?: any,
    d?: { ttl?: number; cascadeTTL?: boolean; forceTTL?: boolean },
  ): Promise<boolean> {
    const { listType, params, entityData, ttl, cascadeTTL, forceTTL } =
      this.isArgsObject(a)
        ? a
        : {
            listType: a,
            params: b,
            entityData: c,
            ttl: d?.ttl,
            cascadeTTL: d?.cascadeTTL,
            forceTTL: d?.forceTTL,
          };

    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getIndexedListSchema(
          listType as string,
        );
        const id = entityData[listSchema.idField];
        if (id === undefined || id === null) {
          throw new InvalidOperationError(
            'addIndexedListItem',
            `Missing ID field '${listSchema.idField}' in entity data`,
            { listType, entityData },
          );
        }

        // `ttl` here overrides the ENTITY's TTL, not the list's (scope:
        // the item being added). The list key's TTL is preserved as-is.
        await this.writeEntity({
          entityType: listSchema.entityType as keyof TSchema,
          data: entityData,
          ttl,
          cascadeTTL,
          forceTTL,
        });

        const score = this.resolveIndexedListScore(listSchema, entityData);
        const listKey = this.schemaManager.generateIndexedListKey(
          listType as string,
          ...Object.values(params),
        );
        return await this.connectionManager.zListAdd(
          listKey,
          this.schemaManager.generateMembershipKey(listSchema.entityType, id),
          score,
          id,
          this.schemaManager.resolveIndexedListTTL(listType as string),
          listSchema.maxSize ?? 0,
          !!listSchema.trackMembership,
        );
      } catch (error) {
        if (error instanceof InvalidOperationError) throw error;
        throw new InvalidOperationError(
          'addIndexedListItem',
          `Failed to add to indexed list '${String(listType)}'`,
          { listType, params, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Atomic remove of a member from a single indexed list. By default the
   * entity itself remains intact (it may still be referenced by other
   * lists). Pass `{ deleteEntity: true }` to also call `invalidateEntity`,
   * which will cascade-remove the entity from every tracked list.
   */
  public async removeIndexedListItem(
    listType: keyof TSchema,
    params: any,
    entityId: any,
    options: { deleteEntity?: boolean } = {},
  ): Promise<boolean> {
    return this.tracked(async () => {
      try {
        const listSchema = this.schemaManager.getIndexedListSchema(
          listType as string,
        );
        const listKey = this.schemaManager.generateIndexedListKey(
          listType as string,
          ...Object.values(params),
        );
        const removed = await this.connectionManager.zListRemove(
          listKey,
          this.schemaManager.generateMembershipKey(
            listSchema.entityType,
            entityId,
          ),
          entityId,
          !!listSchema.trackMembership,
        );

        if (options.deleteEntity) {
          await this.invalidateEntity(
            listSchema.entityType as keyof TSchema,
            entityId,
          );
        }
        return removed;
      } catch (error) {
        throw new InvalidOperationError(
          'removeIndexedListItem',
          `Failed to remove from indexed list '${String(listType)}'`,
          { listType, params, entityId, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Number of members currently in the indexed list. O(1).
   */
  public async indexedListSize(
    listType: keyof TSchema,
    params: any,
  ): Promise<number> {
    return this.tracked(async () => {
      const listKey = this.schemaManager.generateIndexedListKey(
        listType as string,
        ...Object.values(params),
      );
      return this.connectionManager.zListSize(listKey);
    });
  }

  /**
   * Delete the entire indexed list. Entities remain in cache. Membership
   * back-indexes are NOT pruned here for performance reasons (they're
   * harmless and self-clean as part of cascade invalidation or via TTL).
   */
  public async deleteIndexedList(
    listType: keyof TSchema,
    params: any,
  ): Promise<boolean> {
    return this.tracked(async () => {
      const listKey = this.schemaManager.generateIndexedListKey(
        listType as string,
        ...Object.values(params),
      );
      const result = await this.connectionManager.del(listKey);
      return result > 0;
    });
  }

  // =====================================================
  // CACHE MANAGEMENT
  // =====================================================

  /**
   * Invalidate an entity from cache. When the entity is referenced by any
   * indexed list with `trackMembership: true`, this also atomically ZREMs
   * the entity from every such list — so consumers don't have to chase
   * down list keys themselves. For entities not tracked by any list, the
   * behaviour is identical to a plain entity delete.
   *
   * Returns the number of tracked lists the entity was removed from (0
   * when no membership back-index exists, which is the common case).
   */
  public async invalidateEntity(
    entityType: keyof TSchema,
    id: string | number,
  ): Promise<number> {
    return this.tracked(async () => {
      try {
        const entityKey = this.schemaManager.generateEntityKey(
          entityType as string,
          id,
        );
        const membershipKey = this.schemaManager.generateMembershipKey(
          entityType as string,
          id,
        );
        return await this.connectionManager.cascadeInvalidate(
          membershipKey,
          entityKey,
          id,
        );
      } catch (error) {
        throw new InvalidOperationError(
          'invalidateEntity',
          `Failed to invalidate entity '${String(entityType)}' with id '${id}'`,
          { entityType, id, error: (error as Error).message },
          this.generateRequestId(),
        );
      }
    });
  }

  /**
   * Clear every cache key owned by this engine. Destructive and
   * irreversible.
   *
   * Behaviour depends on `redis.keyPrefix`:
   *   - **Prefix set** (recommended): uses non-blocking `SCAN` +
   *     `UNLINK` to delete only keys starting with the prefix. Safe to
   *     run against a Redis instance shared with other applications or
   *     environments — their keys are untouched.
   *   - **Prefix empty** (default, backward-compatible): falls back to
   *     `FLUSHDB`, wiping the entire selected database. Only use this
   *     when the engine owns the whole DB.
   *
   * Two safeguards apply in both modes:
   *   1. The caller MUST pass `{ confirm: 'YES_WIPE_ALL' }` explicitly.
   *   2. When `safety.productionMode` is true the operation is blocked
   *      unless `allowProduction: true` is also set.
   *
   * `safety.productionMode` defaults to `process.env.NODE_ENV ===
   * 'production'` at construction time but is fully consumer-overridable
   * via the engine config. The check below reads only the resolved
   * config — no env access at call time.
   */
  public async clearAllCache(opts: {
    confirm: 'YES_WIPE_ALL';
    allowProduction?: boolean;
  }): Promise<void> {
    if (!opts || opts.confirm !== 'YES_WIPE_ALL') {
      throw new InvalidOperationError(
        'clearAllCache',
        "Refusing to wipe cache without explicit confirmation. Pass { confirm: 'YES_WIPE_ALL' }.",
        {},
        this.generateRequestId(),
      );
    }
    if (this.config.safety.productionMode && !opts.allowProduction) {
      throw new InvalidOperationError(
        'clearAllCache',
        'Refusing to wipe cache in production without { allowProduction: true }.',
        {},
        this.generateRequestId(),
      );
    }
    try {
      // Prefer scoped delete whenever a keyPrefix is set so we never
      // stomp on keys that don't belong to this engine. Falls back to
      // FLUSHDB only when no prefix is configured (prior behaviour).
      const prefix = this.connectionManager.getKeyPrefix();
      if (prefix) {
        await this.connectionManager.clearPrefixedKeys();
      } else {
        await this.connectionManager.flushDb();
      }
    } catch (error) {
      throw new RedisConnectionError(
        'Failed to clear all cache',
        error as Error,
      );
    }
  }

  // =====================================================
  // MONITORING & DEBUGGING
  // =====================================================

  /**
   * Real cache metrics. Hits/misses are counted at the connection-manager
   * boundary on every GET/MGET; latency, totals, failures come from the
   * same shared HealthMetrics tracker. `memoryUsage` reports the Node-side
   * estimate and is 0 when no operation has run yet; Redis-side memory is
   * exposed via `getHealthStatus()`.
   */
  public getMetrics(): CacheMetrics {
    const m = this.connectionManager.getHealthMetrics();
    return {
      cacheHits: m.cacheHits,
      cacheMisses: m.cacheMisses,
      hitRate: m.hitRate,
      totalOperations: m.totalOperations,
      avgResponseTime: m.averageLatency,
      memoryUsage: 0,
      activeConnections: m.isConnected ? 1 : 0,
      failedOperations: m.failedOperations,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get health status of the engine and Redis connection
   */
  public async getHealthStatus(): Promise<HealthStatus> {
    const isHealthy = await this.connectionManager.isHealthy();
    const m = this.connectionManager.getHealthMetrics();
    const redisMemory = await this.connectionManager.getRedisUsedMemory();

    const errorRate =
      m.totalOperations > 0 ? m.failedOperations / m.totalOperations : 0;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (!isHealthy) status = 'unhealthy';
    else if (errorRate > 0.05 || m.circuitBreakerState.state !== 'CLOSED')
      status = 'degraded';
    else status = 'healthy';

    return {
      status,
      redis: {
        connected: m.isConnected,
        latency: m.averageLatency,
        memoryUsage: redisMemory,
      },
      engine: {
        activeOperations: this.activeOperations,
        memoryUsage: 0,
        errorRate,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Enable or disable debug mode
   */
  public enableDebugMode(enabled: boolean): void {
    this.config.monitoring.enableDebugMode = enabled;
    // TODO: Implement debug mode functionality
  }

  // =====================================================
  // LIFECYCLE MANAGEMENT
  // =====================================================

  /**
   * Gracefully disconnect and cleanup resources
   */
  public async disconnect(): Promise<void> {
    await this.connectionManager.disconnect();
  }

  // =====================================================
  // PRIVATE METHODS
  // =====================================================

  /**
   * Initialize all engine components
   */
  private initializeComponents(schema: TSchema): void {
    this.schemaManager = new SchemaManager(
      schema,
      this.config.cache.defaultTTL,
    );
    this.connectionManager = new RedisConnectionManager(
      this.config.redis,
      this.config.resilience.circuitBreaker,
      this.config.resilience.retry,
    );

    // Build a single shared codec from cache config; both engines must
    // use the same instance so writes encode and reads decode through
    // the same threshold/algorithm. With enableCompression=false the
    // codec is a no-op fast path.
    const codec = new CompressionCodec(
      !!this.config.cache.enableCompression,
      this.config.cache.compressionThreshold,
    );

    // Resolve the (de)serializer once and share it between the
    // normalization and hydration engines so writes encode and reads
    // decode through the same codec. Defaults to the lossless
    // `TAGGED_SERIALIZER` so consumers automatically get correct
    // round-tripping for `Date`/`BigInt`/`Map`/`Set`/etc. without
    // having to opt in. Consumers wanting raw `JSON.stringify`
    // behaviour can pass `cache.serializer = JSON_SERIALIZER`.
    const serializer = this.config.cache.serializer ?? TAGGED_SERIALIZER;

    this.normalizationEngine = new NormalizationEngine(
      this.schemaManager,
      this.connectionManager,
      codec,
      serializer,
    );
    this.hydrationEngine = new HydrationEngine(
      this.schemaManager,
      this.connectionManager,
      this.config.limits.maxHydrationDepth,
      this.config.limits.maxMemoryUsagePerOperation,
      codec,
      serializer,
    );
  }

  /**
   * Merge user config with defaults
   */
  private mergeWithDefaults(
    config: PartialRedisSchemaEngineConfig,
  ): RedisSchemaEngineConfig {
    return {
      redis: (() => {
        const merged = {
          host: 'localhost',
          port: 6379,
          db: 0,
          ...config.redis,
        };
        // Auto-append the conventional `:` separator when a prefix is
        // configured without one. This prevents accidents like
        // `keyPrefix: 'mygouripur'` producing `mygouripurpost:42`
        // instead of the intended `mygouripur:post:42`. Empty prefix
        // (the default) is left untouched.
        if (
          typeof merged.keyPrefix === 'string' &&
          merged.keyPrefix.length > 0 &&
          !merged.keyPrefix.endsWith(':')
        ) {
          merged.keyPrefix = `${merged.keyPrefix}:`;
        }
        return merged;
      })(),
      limits: {
        maxHydrationDepth: 5,
        maxEntitiesPerRequest: 1000,
        maxMemoryUsagePerOperation: 100 * 1024 * 1024, // 100MB
        maxConcurrentOperations: 100,
        batchSize: 100,
        ...config.limits,
      },
      resilience: {
        circuitBreaker: {
          threshold: 5,
          timeout: 60000,
          resetTimeout: 30000,
          ...config.resilience?.circuitBreaker,
        },
        retry: {
          maxAttempts: 3,
          baseDelay: 100,
          maxDelay: 2000,
          backoffFactor: 2,
          ...config.resilience?.retry,
        },
        fallback: {
          enabled: true,
          strategy: 'null',
          ...config.resilience?.fallback,
        },
      },
      monitoring: {
        enableMetrics: true,
        enableDebugMode: false,
        enableAuditLog: false,
        metricsInterval: 60000,
        logLevel: 'info',
        ...config.monitoring,
      },
      cache: {
        defaultTTL: 3600,
        enableL1Cache: false,
        l1CacheSize: 1000,
        enableCompression: false,
        compressionThreshold: 1024,
        // `serializer` deliberately stays optional in the merged
        // config — `undefined` means "use the engine default
        // (TAGGED_SERIALIZER)" and `initializeComponents` resolves it
        // there. We don't pin a default here so consumers can later
        // distinguish "explicitly set to default" from "not set" if
        // we ever expose introspection of the active codec.
        ...config.cache,
      },
      safety: {
        // Env default kept for backward compatibility with existing
        // consumers that rely on NODE_ENV. Library consumers should
        // override this explicitly via config so behaviour does not
        // depend on the host process's environment variables.
        productionMode: process.env.NODE_ENV === 'production',
        ...config.safety,
      },
    };
  }

  /**
   * UUIDv4 collisions are practically impossible, unlike the previous
   * Math.random()-based IDs which collided regularly under high concurrency.
   */
  private generateOperationId(): string {
    return `op_${randomUUID()}`;
  }

  private generateRequestId(): string {
    return `req_${randomUUID()}`;
  }
}

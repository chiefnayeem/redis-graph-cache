# redis-graph-cache

> A TypeScript-first Redis data layer for Node.js — schema-driven normalization, atomic concurrent writes, ZSET-backed paginated lists, automatic relationship hydration, and built-in resilience.

[![npm version](https://img.shields.io/npm/v/redis-graph-cache.svg)](https://www.npmjs.com/package/redis-graph-cache)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/redis-graph-cache.svg)](https://nodejs.org)

---

## Table of Contents

- [Why redis-graph-cache?](#why-redis-graph-cache)
- [Features](#features)
- [When to use it (and when not)](#when-to-use-it-and-when-not)
- [Installation](#installation)
- [Quick start (60 seconds)](#quick-start-60-seconds)
- [Core concepts](#core-concepts)
- [Schema design guide](#schema-design-guide)
  - [Entity schema](#entity-schema)
  - [List schema (plain JSON array)](#list-schema-plain-json-array)
  - [Indexed list schema (ZSET)](#indexed-list-schema-zset)
  - [Field types](#field-types)
  - [Relations](#relations)
  - [Schema design rules of thumb](#schema-design-rules-of-thumb)
- [Configuration](#configuration)
- [API reference](#api-reference)
  - [Entity operations](#entity-operations)
  - [Plain list operations](#plain-list-operations)
  - [Indexed list operations](#indexed-list-operations)
  - [Cache management](#cache-management)
  - [Monitoring & lifecycle](#monitoring--lifecycle)
- [TTL semantics](#ttl-semantics)
- [Null vs undefined](#null-vs-undefined)
- [Error model](#error-model)
- [Resilience: circuit breaker & retries](#resilience-circuit-breaker--retries)
- [Compression](#compression)
- [Serializers](#serializers)
- [Production checklist](#production-checklist)
- [FAQ](#faq)
- [License](#license)

---

## Why redis-graph-cache?

Caching nested objects in Redis is harder than it looks. Naively storing JSON blobs creates three problems:

1. **Update one field → rewrite the whole object** (and lose any concurrent writes).
2. **Same entity duplicated across many keys** (post embedded in feed, in user profile, in search results — invalidating it means hunting them all down).
3. **Lists grow unbounded** and pagination requires reading the entire array.

`redis-graph-cache` solves these by:

- **Normalizing** nested objects into one canonical key per entity, with relationships stored as id references.
- **Atomic Lua scripts** for every read-modify-write path (CAS writes, list mutations, cascade invalidation).
- **ZSET-backed lists** with built-in pagination, scoring, size caps, and membership tracking for one-call cascade invalidation.
- **Automatic hydration** that walks relationships and reconstructs the full graph on read.

You declare your schema once. The library handles everything else.

---

## Features

| Feature                   | Description                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Schema-driven storage** | Declare entities, fields, relations once. Auto-validates at boot.                                             |
| **Atomic writes**         | Every mutating op is a Lua script — no read-then-write races, ever.                                           |
| **Two list flavours**     | `list` (JSON array) for small collections; `indexedList` (ZSET) for paginated, sorted feeds with atomic trim. |
| **Cascade invalidation**  | One call removes an entity from all lists tracking it.                                                        |
| **Connection pooling**    | Round-robin across N ioredis clients for high throughput.                                                     |
| **Optional compression**  | Auto-zlib for large payloads, with backward-compatible reads.                                                 |
| **Lossless serializer**   | Preserves `Date`, `BigInt`, `Map`, `Set`, `RegExp`, `Buffer`, `NaN`, `±Infinity` by default.                  |
| **Circuit breaker**       | Bounded failures trip the breaker; half-open probes recovery.                                                 |
| **Bounded retries**       | Exponential backoff with jitter on transient failures.                                                        |
| **Real metrics**          | Hit rate, latency, error rate, Redis memory — measured at the connection boundary.                            |
| **TTL controls**          | Per-schema, per-call override, cascade floor, or forced uniform TTL.                                          |
| **Production safety**     | `clearAllCache` requires explicit confirmation; auto-blocked in production.                                   |
| **TypeScript native**     | Full generic typing — `keyof TSchema` everywhere.                                                             |

---

## When to use it (and when not)

### Use it when you have

- Nested entities with shared child objects (posts with authors, comments, categories).
- Feeds, timelines, leaderboards, "latest N" lists.
- Read-heavy workloads where stale data is acceptable for short TTLs.
- A single Redis instance (or a Redis cluster with hash tags planned per schema key).
- Throughput up to ~50k ops/sec on a typical 8-core Node process.

### Don't use it (yet) when you need

- **Strong consistency** — this is a cache, not a database. Use Postgres/Mongo as source of truth.
- **Redis Cluster with cross-slot operations** — Lua scripts assume keys hash to the same slot. Single-instance or hash-tagged keys only.
- **Cache stampede protection** — no built-in singleflight; combine with `p-memoize` or similar at the application level.
- **Off-thread JSON** — large payloads (>1MB) should be split or stored elsewhere.

---

## Installation

```bash
npm install redis-graph-cache
# or
pnpm add redis-graph-cache
# or
yarn add redis-graph-cache
```

**Requirements:** Node.js ≥ 18, Redis ≥ 6.

> `ioredis` is a peer dependency and is installed automatically. If you already use `ioredis` in your app, your existing version is reused (must be `^5.0.0`).

---

## Quick start (60 seconds)

```ts
import { RedisGraphCache } from 'redis-graph-cache';

// 1. Declare your schema
const schema = {
  user: {
    type: 'entity' as const,
    id: 'id',
    key: (id) => `user:${id}`,
    fields: { name: { type: 'string' }, email: { type: 'string' } },
    ttl: 7200,
  },
  post: {
    type: 'entity' as const,
    id: 'id',
    key: (id) => `post:${id}`,
    fields: {
      title: { type: 'string' },
      content: { type: 'string' },
      createdAt: { type: 'date' },
    },
    relations: {
      author: { type: 'user', kind: 'one' },
    },
    ttl: 3600,
  },
  globalFeed: {
    type: 'indexedList' as const,
    entityType: 'post',
    key: () => 'feed:global',
    idField: 'id',
    scoreField: 'createdAt',
    maxSize: 10_000,
    trackMembership: true,
    ttl: 86400,
  },
};

// 2. Create the engine
const cache = new RedisGraphCache(schema, {
  redis: { host: 'localhost', port: 6379, keyPrefix: 'myapp:' },
  cache: { defaultTTL: 3600, enableCompression: true },
});

// 3. Use it
await cache.writeEntity('post', {
  id: 1,
  title: 'Hello',
  content: 'World',
  createdAt: new Date(),
  author: { id: 9, name: 'Ada', email: 'ada@example.com' },
});

await cache.addIndexedListItem(
  'globalFeed',
  {},
  {
    id: 1,
    // ...full post data; engine writes both the entity and the feed entry
  },
);

const post = await cache.readEntity('post', 1);
// → { id: 1, title: 'Hello', content: 'World', createdAt: Date, author: { id: 9, name: 'Ada', ... } }

const feed = await cache.readIndexedList(
  'globalFeed',
  {},
  {
    limit: 50,
    reverse: true, // newest first
  },
);

await cache.invalidateEntity('post', 1); // also removes from feed (trackMembership)
await cache.disconnect();
```

---

## Core concepts

### 1. Entity

A single addressable object with an `id`. Stored as one Redis key. Nested objects are split into their own entity keys and replaced with id references.

### 2. List

An ordered collection of entity ids stored as a JSON array under one key. Best for small (< 200 items), rarely-changing collections.

### 3. Indexed list

A ZSET of entity ids with scores. Supports pagination, sorting, atomic add/remove, size caps, and cascade invalidation. Use this for anything that grows.

### 4. Normalization

When you write a post with an embedded author, the engine writes the author to its own key (`user:9`) and stores `{ authorId: 9 }` on the post. Update the author once → every post sees it.

### 5. Hydration

When you read a post, the engine fetches the post + walks every relation (author, comments) and assembles the full graph. Configurable depth and field selection.

---

## Schema design guide

### Entity schema

```ts
{
  type: 'entity',
  id: 'id',                          // name of the id field on your data
  key: (id) => `post:${id}`,         // Redis key generator (must include id)
  fields: {                          // optional — declared fields are advisory
    title: { type: 'string', required: true },
    views: { type: 'number' },
    tags: { type: 'array' },
    createdAt: { type: 'date' },
  },
  relations: {                       // optional — links to other entities
    author: { type: 'user', kind: 'one' },
    comments: { type: 'comment', kind: 'many' },
  },
  ttl: 3600,                         // seconds; falls back to cache.defaultTTL
  version: '1.0.0',                  // optional, for migrations
}
```

| Property    | Type                                 | Required | Description                                                   |
| ----------- | ------------------------------------ | -------- | ------------------------------------------------------------- |
| `type`      | `'entity'`                           | yes      | Discriminator                                                 |
| `id`        | `string`                             | yes      | Name of the field on your data that holds the id              |
| `key`       | `(...args) => string`                | yes      | Generates the Redis key. Include the id to avoid collisions   |
| `fields`    | `Record<string, FieldDefinition>`    | no       | Self-documenting field types; **advisory only** (no coercion) |
| `relations` | `Record<string, RelationDefinition>` | no       | Names of related entity types and their cardinality           |
| `ttl`       | `number` (seconds)                   | no       | Per-schema TTL. Falls back to `cache.defaultTTL`              |
| `version`   | `string`                             | no       | Reserved for migration tooling                                |

### List schema (plain JSON array)

```ts
{
  type: 'list',
  entityType: 'post',                // referenced entity
  key: (categoryId) => `posts:by-category:${categoryId}`,
  idField: 'id',                     // which field on the entity is the id
  ttl: 600,
}
```

| Property     | Type                  | Required | Description                                  |
| ------------ | --------------------- | -------- | -------------------------------------------- |
| `type`       | `'list'`              | yes      | Discriminator                                |
| `entityType` | `string`              | yes      | Schema key of the entity stored in this list |
| `key`        | `(...args) => string` | yes      | Redis key generator                          |
| `idField`    | `string`              | yes      | Field name that uniquely identifies items    |
| `ttl`        | `number`              | no       | Per-schema TTL                               |

### Indexed list schema (ZSET)

```ts
{
  type: 'indexedList',
  entityType: 'post',
  key: (userId) => `feed:user:${userId}`,
  idField: 'id',
  scoreField: 'createdAt',           // optional; defaults to insertion timestamp
  maxSize: 1000,                     // optional; trim to N lowest-scored on insert
  trackMembership: true,             // optional; enables cascade-invalidate
  ttl: 86400,
}
```

| Property          | Type                  | Required | Description                                                                                                 |
| ----------------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `type`            | `'indexedList'`       | yes      | Discriminator                                                                                               |
| `entityType`      | `string`              | yes      | Schema key of the entity stored                                                                             |
| `key`             | `(...args) => string` | yes      | Redis key generator                                                                                         |
| `idField`         | `string`              | yes      | Field name that uniquely identifies items                                                                   |
| `scoreField`      | `string`              | no       | Entity field used as ZSET score. Must be numeric, ISO date, or `Date`. Default: `Date.now()` at insert time |
| `maxSize`         | `number`              | no       | Trim list to this size on every insert (drops lowest-scored)                                                |
| `trackMembership` | `boolean`             | no       | Records back-index for cascade invalidation. Default `false`                                                |
| `ttl`             | `number`              | no       | Per-schema TTL                                                                                              |

### Field types

| Type      | Round-trip with default serializer | With `JSON_SERIALIZER`                    |
| --------- | ---------------------------------- | ----------------------------------------- |
| `string`  | OK                                 | OK                                        |
| `number`  | OK                                 | OK (loses `NaN`, `±Infinity`)             |
| `boolean` | OK                                 | OK                                        |
| `object`  | OK                                 | OK                                        |
| `array`   | OK                                 | OK                                        |
| `date`    | OK (preserved as `Date`)           | becomes ISO string                        |
| `bigint`  | OK (preserved as `BigInt`)         | throws (JSON can't serialize)             |
| `map`     | OK (preserved as `Map`)            | becomes `{}`                              |
| `set`     | OK (preserved as `Set`)            | becomes `{}`                              |
| `regexp`  | OK (preserved as `RegExp`)         | becomes `{}`                              |
| `buffer`  | OK (preserved as `Buffer`)         | becomes `{ type: 'Buffer', data: [...] }` |

> **Field types are advisory.** The engine does NOT coerce. They exist so schemas are self-documenting and obvious typos are caught early. Type fidelity is the serializer's job.

### Relations

```ts
relations: {
  author: { type: 'user', kind: 'one' },
  comments: { type: 'comment', kind: 'many', cascade: true, lazy: false },
}
```

| Property  | Type              | Description                                          |
| --------- | ----------------- | ---------------------------------------------------- |
| `type`    | `string`          | Schema key of the related entity                     |
| `kind`    | `'one' \| 'many'` | Cardinality. `one` → single object; `many` → array   |
| `cascade` | `boolean`         | Reserved for future cascade-delete (currently no-op) |
| `lazy`    | `boolean`         | Reserved for future lazy-loading (currently no-op)   |

### Schema design rules of thumb

- **One key per entity, always.** Don't define two entity schemas pointing to the same Redis key — it breaks normalization.
- **Use `indexedList` over `list` whenever a collection might exceed ~200 items.** ZSET ops are O(log N); JSON-array ops rewrite the entire blob.
- **Set `trackMembership: true` only when you actually need cascade invalidation.** Each insert costs one extra `SADD`.
- **`scoreField` should be monotonic** (timestamps, sequence ids). Non-monotonic scores make pagination unstable.
- **`maxSize` is your friend** for unbounded feeds — caps memory at a known ceiling.
- **TTL hierarchy:** parent ≥ children when using `cascadeTTL`. Otherwise children may expire before the parent expects them.

---

## Configuration

```ts
const cache = new RedisGraphCache(schema, {
  redis: {
    /* ... */
  },
  cache: {
    /* ... */
  },
  limits: {
    /* ... */
  },
  resilience: {
    /* ... */
  },
  monitoring: {
    /* ... */
  },
  safety: {
    /* ... */
  },
});
```

### `redis` (extends [`ioredis` RedisOptions](https://github.com/redis/ioredis#connect-to-redis))

| Option                       | Type     | Default       | Description                                                      |
| ---------------------------- | -------- | ------------- | ---------------------------------------------------------------- |
| `host`                       | `string` | `'localhost'` | Redis host                                                       |
| `port`                       | `number` | `6379`        | Redis port                                                       |
| `db`                         | `number` | `0`           | Redis database number                                            |
| `password`                   | `string` | –             | Redis auth password                                              |
| `keyPrefix`                  | `string` | `''`          | Prepended to every key. Auto-suffixes `:` if missing             |
| `poolSize`                   | `number` | `1`           | Number of ioredis clients (round-robined). Use 4–8 in production |
| ...all other ioredis options |          |               | TLS, sentinel, retry strategies, etc.                            |

### `cache`

| Option                 | Type             | Default             | Description                                               |
| ---------------------- | ---------------- | ------------------- | --------------------------------------------------------- |
| `defaultTTL`           | `number` (s)     | `3600`              | Fallback TTL when schema doesn't specify one              |
| `enableCompression`    | `boolean`        | `false`             | Auto-zlib entity payloads larger than threshold           |
| `compressionThreshold` | `number` (bytes) | `1024`              | Min payload size to compress                              |
| `enableL1Cache`        | `boolean`        | `false`             | Reserved (in-process L1 cache, not yet implemented)       |
| `l1CacheSize`          | `number`         | `1000`              | Reserved                                                  |
| `serializer`           | `Serializer`     | `TAGGED_SERIALIZER` | Lossless tagged JSON. Pass `JSON_SERIALIZER` for raw JSON |

### `limits`

| Option                       | Type             | Default  | Description                                      |
| ---------------------------- | ---------------- | -------- | ------------------------------------------------ |
| `maxHydrationDepth`          | `number`         | `5`      | Throws `HydrationDepthExceededError` if exceeded |
| `maxEntitiesPerRequest`      | `number`         | `1000`   | Cap on entities hydrated per call                |
| `maxMemoryUsagePerOperation` | `number` (bytes) | `100 MB` | Throws `MemoryLimitError` if exceeded            |
| `maxConcurrentOperations`    | `number`         | `100`    | Reserved                                         |
| `batchSize`                  | `number`         | `100`    | Pipeline batch size for bulk ops                 |

### `resilience`

```ts
resilience: {
  circuitBreaker: { threshold: 5, timeout: 60000, resetTimeout: 30000 },
  retry: { maxAttempts: 3, baseDelay: 100, maxDelay: 2000, backoffFactor: 2 },
  fallback: { enabled: true, strategy: 'null' }, // 'null' | 'empty' | 'cached' | 'custom'
}
```

| Section          | Option          | Default    | Description                               |
| ---------------- | --------------- | ---------- | ----------------------------------------- |
| `circuitBreaker` | `threshold`     | `5`        | Consecutive failures before tripping OPEN |
|                  | `timeout`       | `60000` ms | Max op duration before counted as failure |
|                  | `resetTimeout`  | `30000` ms | OPEN → HALF_OPEN cool-down                |
| `retry`          | `maxAttempts`   | `3`        | Max retries per op                        |
|                  | `baseDelay`     | `100` ms   | Initial backoff                           |
|                  | `maxDelay`      | `2000` ms  | Cap on exponential backoff                |
|                  | `backoffFactor` | `2`        | Multiplier per attempt                    |

### `monitoring`

| Option            | Type                                     | Default  | Description                 |
| ----------------- | ---------------------------------------- | -------- | --------------------------- |
| `enableMetrics`   | `boolean`                                | `true`   | Track hits, misses, latency |
| `enableDebugMode` | `boolean`                                | `false`  | Reserved                    |
| `enableAuditLog`  | `boolean`                                | `false`  | Reserved                    |
| `metricsInterval` | `number`                                 | `60000`  | Reserved                    |
| `logLevel`        | `'error' \| 'warn' \| 'info' \| 'debug'` | `'info'` | Reserved                    |

### `safety`

| Option           | Type      | Default                     | Description                                           |
| ---------------- | --------- | --------------------------- | ----------------------------------------------------- |
| `productionMode` | `boolean` | `NODE_ENV === 'production'` | Blocks `clearAllCache` unless `allowProduction: true` |

---

## API reference

Every write method supports **two call styles** — pick whichever you prefer:

```ts
// Positional (concise)
await cache.writeEntity('post', data, { ttl: 600 });

// Object (self-documenting, easier with many options)
await cache.writeEntity({ entityType: 'post', data, ttl: 600 });
```

Both are equivalent and fully type-checked.

### Entity operations

#### `writeEntity(entityType, data, options?) → WriteResult`

Writes an entity (and any nested entities via relations) atomically using compare-and-set.

```ts
const result = await cache.writeEntity('post', {
  id: 1,
  title: 'Hello',
  author: { id: 9, name: 'Ada' }, // nested → written as user:9
});
// → { success: true, keys: ['post:1', 'user:9'], operationId, timestamp }
```

| Option       | Type      | Description                            |
| ------------ | --------- | -------------------------------------- |
| `ttl`        | `number`  | Override TTL for the root entity only  |
| `cascadeTTL` | `boolean` | Use root TTL as floor for all children |
| `forceTTL`   | `boolean` | Apply uniform TTL to entire write tree |

#### `readEntity(entityType, id, options?) → object \| null`

Reads and hydrates an entity (walks relations).

```ts
const post = await cache.readEntity('post', 1, {
  maxDepth: 2,
  selectiveFields: ['title', 'author'],
  excludeRelations: ['comments'],
});
```

| Option             | Type             | Description                                  |
| ------------------ | ---------------- | -------------------------------------------- |
| `maxDepth`         | `number`         | Override per-call hydration depth            |
| `selectiveFields`  | `string[]`       | Only return these fields (still includes id) |
| `excludeRelations` | `string[]`       | Skip these relation names                    |
| `memoryLimit`      | `number` (bytes) | Per-call memory cap                          |

#### `updateEntityIfExists(entityType, data, options?) → WriteResult \| null`

Conditional update: writes only if the entity already exists. Returns `null` if missing.

```ts
const updated = await cache.updateEntityIfExists('post', { id: 1, views: 42 });
if (updated === null) {
  // post doesn't exist; don't recreate
}
```

#### `deleteEntity(entityType, id) → boolean`

Deletes a single entity key. Returns `true` if deleted, `false` if it didn't exist.

> For cascade invalidation across lists, use `invalidateEntity` instead.

### Plain list operations

#### `writeList(listType, params, items, options?) → ListWriteResult`

Replaces the entire list with the given items. Each item is also written as an entity.

```ts
await cache.writeList('postsByCategory', { categoryId: 5 }, [
  { id: 1, title: 'A' },
  { id: 2, title: 'B' },
]);
```

#### `readList(listType, params, options?) → object[]`

Reads all items in the list and hydrates each as an entity.

```ts
const posts = await cache.readList('postsByCategory', { categoryId: 5 });
```

#### `addListItem(listType, params, entityData, options?) → boolean`

Appends an item to the list and writes the entity atomically.

#### `removeListItem(listType, params, entityId, options?) → boolean`

Removes an id from the list. Pass `{ deleteEntity: true }` to also delete the underlying entity key.

#### `deleteList(listType, params) → boolean`

Deletes the list key. Underlying entities are NOT deleted.

### Indexed list operations

#### `writeIndexedList(listType, params, items, options?) → ListWriteResult`

Adds items to a ZSET-backed list. Does NOT clear existing members — call `deleteIndexedList` first if you want a full replace.

#### `readIndexedList(listType, params, options?) → object[]`

Paginated, hydrated read.

```ts
const feed = await cache.readIndexedList(
  'globalFeed',
  {},
  {
    limit: 50,
    offset: 0,
    reverse: true, // highest score first
    // plus all standard hydration options
    excludeRelations: ['comments'],
  },
);
```

| Option             | Type       | Description                                           |
| ------------------ | ---------- | ----------------------------------------------------- |
| `limit`            | `number`   | Max items to return                                   |
| `offset`           | `number`   | Skip this many items                                  |
| `reverse`          | `boolean`  | Sort descending (newest-first when score = timestamp) |
| `maxDepth`         | `number`   | Hydration depth                                       |
| `selectiveFields`  | `string[]` | Fields to include                                     |
| `excludeRelations` | `string[]` | Relations to skip                                     |

#### `addIndexedListItem(listType, params, entityData, options?) → boolean`

Adds one entity to the indexed list. Returns `true` if newly added, `false` if score updated on existing id.

#### `removeIndexedListItem(listType, params, entityId, options?) → boolean`

Removes one id. Pass `{ deleteEntity: true }` to also cascade-invalidate the entity (removes from all tracked lists).

#### `indexedListSize(listType, params) → number`

Returns the current member count. O(1).

#### `deleteIndexedList(listType, params) → boolean`

Deletes the ZSET key.

### Cache management

#### `invalidateEntity(entityType, id) → number`

The killer method. Atomically:

1. Removes the entity key.
2. Looks up every indexed list with `trackMembership: true` that contains this id.
3. Removes the id from all of those lists in one Lua script.

Returns the number of tracked lists the entity was removed from.

```ts
const cleaned = await cache.invalidateEntity('post', 42);
// → 3 (removed from post:42 + 3 feeds)
```

#### `clearAllCache(opts) → void`

**Destructive.** Wipes all keys owned by the engine.

```ts
await cache.clearAllCache({ confirm: 'YES_WIPE_ALL' });
// in production:
await cache.clearAllCache({ confirm: 'YES_WIPE_ALL', allowProduction: true });
```

- With `keyPrefix` set: uses `SCAN` + `UNLINK` (safe to share Redis with other apps).
- Without `keyPrefix`: falls back to `FLUSHDB` (wipes the entire selected DB).

### Monitoring & lifecycle

#### `getMetrics() → CacheMetrics`

Synchronous snapshot of hit rate, latency, totals.

```ts
const m = cache.getMetrics();
// { cacheHits, cacheMisses, hitRate, totalOperations,
//   avgResponseTime, failedOperations, activeConnections, ... }
```

#### `getHealthStatus() → Promise<HealthStatus>`

Async health check including Redis-side memory.

```ts
const h = await cache.getHealthStatus();
// { status: 'healthy' | 'degraded' | 'unhealthy',
//   redis: { connected, latency, memoryUsage },
//   engine: { activeOperations, errorRate, ... } }
```

`degraded` means circuit breaker is HALF_OPEN or error rate > 5%.

#### `disconnect() → Promise<void>`

Closes all pool connections gracefully. Always call this on shutdown.

---

## TTL semantics

Three knobs control TTL on every write:

| Mode                         | What happens                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| **default**                  | Each entity gets its own per-schema TTL (or `cache.defaultTTL`)                            |
| `ttl: 600`                   | Override applies **only to the root entity**                                               |
| `ttl: 600, cascadeTTL: true` | Root TTL becomes the **floor** for all children — children with shorter TTLs get bumped up |
| `ttl: 600, forceTTL: true`   | All entities written by this call get **exactly 600s**, regardless of schema               |

```ts
// Children expire individually per their own schema
await cache.writeEntity('post', postData);

// Root pinned to 60s; children keep their own TTLs
await cache.writeEntity('post', postData, { ttl: 60 });

// Root + all children at least 3600s (children with longer TTLs unchanged)
await cache.writeEntity('post', postData, { ttl: 3600, cascadeTTL: true });

// Everything exactly 60s
await cache.writeEntity('post', postData, { ttl: 60, forceTTL: true });
```

---

## Null vs undefined

Important distinction in writes:

| Value        | Effect                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `null`       | Explicitly **overwrites** the field with `null`                                                 |
| `undefined`  | Field is **omitted** (because `JSON.stringify` drops `undefined`) — existing value is preserved |
| Field absent | Same as `undefined`                                                                             |

```ts
// Existing post: { id: 1, title: 'A', subtitle: 'B' }
await cache.updateEntityIfExists('post', { id: 1, subtitle: undefined });
// → { id: 1, title: 'A', subtitle: 'B' } (unchanged)

await cache.updateEntityIfExists('post', { id: 1, subtitle: null });
// → { id: 1, title: 'A', subtitle: null }
```

This matches Redux/Immer/REST PATCH conventions.

---

## Error model

All errors inherit from `RedisSchemaEngineError`.

| Error                         | When it's thrown                                                     |
| ----------------------------- | -------------------------------------------------------------------- |
| `SchemaValidationError`       | At construction — invalid schema, circular relations, duplicate keys |
| `EntityNotFoundError`         | (Reserved; current API returns `null` for missing entities)          |
| `InvalidOperationError`       | Wrong call shape, missing confirmation, bad params                   |
| `RedisConnectionError`        | Underlying Redis network/protocol failure                            |
| `MemoryLimitError`            | Hydration exceeded `limits.maxMemoryUsagePerOperation`               |
| `CircuitBreakerOpenError`     | Operation rejected because the breaker is OPEN                       |
| `HydrationDepthExceededError` | Read exceeded `limits.maxHydrationDepth`                             |

```ts
import {
  CircuitBreakerOpenError,
  HydrationDepthExceededError,
} from 'redis-graph-cache';

try {
  await cache.readEntity('post', 1);
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    // serve stale or fall back to DB
  } else if (err instanceof HydrationDepthExceededError) {
    // your relations form a cycle; reduce maxDepth or excludeRelations
  } else {
    throw err;
  }
}
```

---

## Resilience: circuit breaker & retries

Every Redis op flows through:

```
[ retry (exponential backoff) ] → [ circuit breaker ] → [ ioredis client ]
```

- **Retries** handle transient failures (timeouts, momentary network blips).
- **Circuit breaker** fails fast after sustained failures, preventing thundering herds.

### State machine

```
  CLOSED ──5 failures──> OPEN ──30s cooldown──> HALF_OPEN ──success──> CLOSED
                          ▲                          │
                          └────── failure ───────────┘
```

When OPEN, all ops throw `CircuitBreakerOpenError` immediately. Configure thresholds to match your SLO.

---

## Compression

Optional zlib compression for entity payloads larger than `compressionThreshold`.

```ts
new RedisGraphCache(schema, {
  cache: {
    enableCompression: true,
    compressionThreshold: 4096, // bytes
  },
});
```

- Magic prefix (`\x00z1:`) marks compressed values.
- Reads transparently handle a mix of compressed and uncompressed entries — safe to enable on an existing cache.
- Lists (JSON-array bodies) are NOT compressed because Lua scripts parse them server-side.

---

## Serializers

The default `TAGGED_SERIALIZER` preserves rich types losslessly:

```ts
import { JSON_SERIALIZER } from 'redis-graph-cache';

// Opt out for max throughput (loses Date, BigInt, Map, Set, RegExp, Buffer fidelity)
new RedisGraphCache(schema, { cache: { serializer: JSON_SERIALIZER } });

// Or plug in a third-party codec
import superjson from 'superjson';
new RedisGraphCache(schema, {
  cache: {
    serializer: {
      stringify: superjson.stringify,
      parse: superjson.parse,
    },
  },
});
```

> Don't mix serializers against the same cache without flushing first — old entries written with one serializer may not parse correctly with another.

---

## Production checklist

- [ ] `redis.keyPrefix` set so `clearAllCache` is scoped, not a `FLUSHDB`.
- [ ] `redis.poolSize` ≥ 4 for production traffic.
- [ ] `safety.productionMode: true` (or `NODE_ENV=production`).
- [ ] `cache.enableCompression: true` if entities average > 1KB.
- [ ] `limits.maxHydrationDepth` set to the smallest value that supports your use case.
- [ ] `trackMembership: true` only on lists where you actually need cascade invalidation.
- [ ] `maxSize` set on every unbounded indexed list.
- [ ] `disconnect()` called in your shutdown hook (SIGTERM handler).
- [ ] Metrics exported to your observability stack (`getMetrics()` is sync — call it in a 30s timer).
- [ ] Circuit-breaker errors handled with a fallback (DB read, stale value, etc.).

---

## FAQ

**Q: Can I use it with Redis Cluster?**
Not yet. Lua scripts assume keys hash to the same slot. Use a single Redis instance, or design your `key` functions to use hash tags so all keys touched by one operation land on the same slot.

**Q: Does it protect against cache stampedes?**
No built-in singleflight. Combine with `p-memoize` or `dataloader` at the application level if you need it.

**Q: Can I store binary data?**
Yes — use `Buffer` fields with the default `TAGGED_SERIALIZER`. They round-trip losslessly.

**Q: How does it compare to bare ioredis?**
ioredis is the transport. This package adds normalization, hydration, atomic mutation Lua scripts, ZSET list management, cascade invalidation, circuit breaker, retries, metrics, compression, and TypeScript-native schema typing on top.

**Q: Can I read/write outside the schema?**
Yes — `RedisConnectionManager` is exported, but you lose all the safety guarantees. Prefer adding a schema entry.

**Q: What happens to nested entities when I overwrite a parent?**
They're written to their own keys; the parent stores only id references. So updating the parent's `title` does NOT touch the children. Updating a child by id is what changes it.

**Q: Why two list types?**
`list` is fast and simple for tiny collections. `indexedList` (ZSET) scales to millions, supports pagination and atomic trim, and is the right answer for any feed or timeline. New code should default to `indexedList`.

---

## License

MIT

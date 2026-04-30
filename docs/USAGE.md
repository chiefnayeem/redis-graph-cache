# Redis Graph Cache — Complete Usage Guide

This is the reference manual. Every public method, configuration option,
and behavioural contract the cache implements is documented here. For a
high-level overview see [`README.md`](OVERVIEW.md); for `null`/`undefined`
edge cases see [`NULL_UNDEFINED_HANDLING.md`](NULL_UNDEFINED_HANDLING.md).

## Table of contents

1. [Installation](#installation)
2. [Concepts](#concepts)
3. [Schema definition](#schema-definition)
   - [Entity schema](#entity-schema)
   - [Plain list schema (`list`)](#plain-list-schema)
   - [Indexed list schema (`indexedList`)](#indexed-list-schema)
4. [Initialization](#initialization)
5. [Configuration](#configuration)
6. [Entity operations](#entity-operations)
7. [Plain list operations](#plain-list-operations)
8. [Indexed list operations](#indexed-list-operations)
9. [Write API call styles (object form + per-call `ttl`)](#write-api-call-styles)
10. [TTL cascade between parent and child entities](#ttl-cascade-between-parent-and-child-entities)
11. [Cache management & invalidation](#cache-management--invalidation)
12. [Connection pool](#connection-pool)
13. [Compression](#compression)
14. [Monitoring & health](#monitoring--health)
15. [Hydration options](#hydration-options)
16. [Error model](#error-model)
17. [Atomicity & concurrency contract](#atomicity--concurrency-contract)
18. [Operational guidance](#operational-guidance)
19. [Migration notes](#migration-notes)

---

## Installation

```bash
npm install ioredis
npm install --save-dev @types/ioredis
```

The cache has one runtime dependency: `ioredis`. No additional packages
are required for compression (uses Node's built-in `zlib`) or for the
atomic Lua scripts (built into Redis itself).

---

## Concepts

This library treats your Redis store as a normalized data graph with three
kinds of registered schemas:

- **Entity** — a single addressable object with optional fields and
  one-to-one / one-to-many relations to other entities.
- **List** — a collection of entity ids stored as a single JSON array
  string. Cheap, fine for short collections.
- **Indexed list** — a collection of entity ids stored as a Redis ZSET,
  enabling paginated reads, sorting by any numeric or timestamp field,
  size capping, and cascade invalidation. Use this for any list that
  may grow beyond a few hundred items or needs efficient pagination.

When you write an entity that contains nested relations, the cache
**normalizes** the input: each relation becomes its own Redis key, with
the parent storing references via internal `__rse_*Id` / `__rse_*Ids`
fields. On read, **hydration** reverses the process and reconstructs the
nested object graph.

All read-modify-write paths are protected by atomic Lua scripts, so
concurrent writes converge correctly without client-side locks.

---

## Schema definition

A schema is a flat record where every key is a registered name and every
value is one of the three schema kinds.

### Entity schema

```ts
const post = {
  type: 'entity' as const,
  id: 'id', // name of the field that holds the entity's primary id
  key: (id: string | number) => `post:${id}`, // Redis key generator
  fields: {
    title: { type: 'string' as const },
    content: { type: 'string' as const },
    views: { type: 'number' as const },
    published: { type: 'boolean' as const },
    metadata: { type: 'object' as const },
    tags: { type: 'array' as const },
    createdAt: { type: 'string' as const },
  },
  relations: {
    author: { type: 'user', kind: 'one' as const },     // 1:1
    comments: { type: 'comment', kind: 'many' as const }, // 1:N
    category: { type: 'category', kind: 'one' as const },
  },
  ttl: 3600, // optional; seconds. Falls back to cache.defaultTTL.
  version: '1.0.0', // optional metadata
};
```

**Field types** are advisory; the cache does not coerce values. They
are validated for membership in the allowed set
(`'string' | 'number' | 'boolean' | 'object' | 'array'`) and used for
schema-level documentation.

**Relation kinds**:
- `'one'` stores a single foreign id under `__rse_<name>Id`.
- `'many'` stores an array of foreign ids under `__rse_<name>Ids`.

**Reserved field names**: any key starting with `__rse_` is rejected at
schema registration time to prevent collisions with internal metadata.

**Key naming convention — required for correct TTL resolution**: The string you
register the entity under in the schema object **must be identical to the prefix
your `key` function emits before the first `:`**. The TTL resolver identifies
which schema to consult at write time by extracting that prefix from the Redis
key. When the two differ, the lookup silently returns `0`, and the cascade-floor
guard treats `0` as "this entity should live forever" — the key gets no TTL in
Redis regardless of any `ttl` or `cascadeTTL` you pass.

```ts
// ✓ Correct — schema name matches key prefix
const schema = {
  pageCourse: {
    type: 'entity' as const,
    key: (id) => `pageCourse:${id}`,  // prefix 'pageCourse' == schema name
    ttl: 3600,
  },
};

// ✗ Wrong — 'course' prefix does not match schema name 'pageCourse'
const schema = {
  pageCourse: {
    type: 'entity' as const,
    key: (id) => `course:${id}`,   // prefix 'course' ≠ 'pageCourse'
    ttl: 3600,  // silently ignored under cascadeTTL; Redis shows "No Limit"
  },
};
```

This rule applies **only to entity schemas that can appear as embedded relations
inside other entities** (i.e. any schema referenced in another schema's
`relations` block). `list` and `indexedList` schemas are not subject to it —
their keys are never passed through the entity-type resolver. Entity schemas
that are always written in isolation and never embedded as relations are also
exempt, but the safest convention is to keep schema name == key prefix for all
entity schemas without exception.

### Plain list schema

A `list` is a JSON array of ids stored under a single Redis key. Best
for short, flat collections.

```ts
const recentPosts = {
  type: 'list' as const,
  entityType: 'post', // must match a registered entity schema
  key: (...params: any[]) => `posts:recent`,
  idField: 'id', // which field on entities provides the id
  ttl: 600,
};
```

Trade-offs:
- **Pros**: minimal storage, simple Lua scripts, atomic add/remove.
- **Cons**: every read of any page parses the whole array. Not suitable
  for lists with thousands of items or for sorted/paginated access.

### Indexed list schema

A `indexedList` stores ids in a Redis ZSET, scored by any field on the
entity (defaulting to insertion timestamp). Reads are paginated;
writes are atomic; size caps and cascade invalidation are supported.

```ts
const globalFeed = {
  type: 'indexedList' as const,
  entityType: 'post',
  key: (...params: any[]) => `feed:global`,
  idField: 'id',
  scoreField: 'createdAt', // optional; defaults to insertion time
  maxSize: 10_000,         // optional; trims oldest beyond this
  trackMembership: true,   // optional; enables cascade invalidation
  ttl: 86400,
};
```

**Score derivation**:
1. If `scoreField` is omitted, the score is `Date.now()` at insertion
   time. Reading `reverse: true` yields newest-first.
2. If `scoreField` is set, the cache reads
   `entity[scoreField]` and converts via `Number(value)`. If that's
   non-finite it tries `new Date(value).getTime()`. ISO 8601 strings,
   `Date` objects, numeric strings, and numbers all work.
3. If neither conversion yields a finite number, the cache throws
   `InvalidOperationError` rather than silently scoring at 0.

**Max size**: applied atomically inside the Lua script via
`ZREMRANGEBYRANK`. Writers cannot temporarily blow past the cap.

**Membership tracking**: when `trackMembership: true`, every insert
also adds the list key to a per-entity back-index set
(`__rse_membership:<entityType>:<id>`). On `invalidateEntity`, the
cache atomically reads that back-index and `ZREM`s the entity from
every tracked list. The back-index has a TTL of `4 × list.ttl` so it
survives at least one round of list TTL expiry. **Do not enable this
unless you actually need cascade invalidation** — it doubles the
write traffic per insert.

---

## Initialization

```ts
import { RedisGraphCache } from './redis';

const cache = new RedisGraphCache(schema, config);
```

- The constructor synchronously validates the schema and throws
  `SchemaValidationError` if anything is malformed (unknown relation
  target, invalid field type, internal-prefix collision, etc.).
- ioredis clients connect immediately by default. `lazyConnect: true`
  on the redis options will defer connection until you call
  `await cache.connect()`.
- The cache registers all atomic Lua scripts on every pool client at
  construction time. There is no on-demand script loading.

---

## Configuration

```ts
const cache = new RedisGraphCache(schema, {
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'secret',     // optional
    db: 0,
    keyPrefix: 'mygouripur:',  // namespace every key (see "Key namespacing" below)
    poolSize: 8,            // pool of ioredis clients (round-robin)
    connectTimeout: 10000,  // ioredis option
    commandTimeout: 5000,   // ioredis option
    // ...any other ioredis options
  },

  limits: {
    maxHydrationDepth: 5,
    maxEntitiesPerRequest: 1000,
    maxMemoryUsagePerOperation: 100 * 1024 * 1024, // 100 MB
    maxConcurrentOperations: 100,
    batchSize: 100,
  },

  resilience: {
    circuitBreaker: {
      threshold: 5,        // failures before opening
      timeout: 60000,
      resetTimeout: 30000, // ms before next half-open probe
    },
    retry: {
      maxAttempts: 3,
      baseDelay: 100,
      maxDelay: 2000,
      backoffFactor: 2,
    },
    fallback: {
      enabled: true,
      strategy: 'null',
    },
  },

  monitoring: {
    enableMetrics: true,
    enableDebugMode: false,
    enableAuditLog: false,
    metricsInterval: 60000,
    logLevel: 'info',
  },

  cache: {
    defaultTTL: 3600,        // seconds, applied when a schema omits ttl
    enableL1Cache: false,    // (reserved; not implemented)
    l1CacheSize: 1000,       // (reserved; not implemented)
    enableCompression: true,
    compressionThreshold: 4096, // bytes
  },

  safety: {
    // When true, clearAllCache() additionally requires
    // { allowProduction: true }. Defaults to
    // process.env.NODE_ENV === 'production' at cache construction
    // time so existing consumers keep their behaviour. Library
    // consumers should pass this explicitly to avoid env coupling.
    productionMode: process.env.NODE_ENV === 'production',
  },
});
```

All sections are optional; partial configs are deep-merged with the
defaults shown. `redis` defaults host to `localhost`, port to `6379`,
db to `0`. `poolSize` defaults to `1` for backward compatibility.
`safety.productionMode` defaults from `process.env.NODE_ENV` once at
construction time; the cache itself reads no env vars at runtime, so
the library is safe to package and distribute as an npm module.

> **Reserved-but-not-implemented**: `cache.enableL1Cache`,
> `cache.l1CacheSize`, and `redis.connectionPool` (the generic-pool
> style nested config) are accepted for forward compatibility but are
> not currently used. Use `redis.poolSize` for connection pooling.

---

## Entity operations

### `writeEntity(entityType, data) → Promise<WriteResult>`

Normalizes the input and writes every resulting key with an atomic
compare-and-set merge. Nested relations are recursively normalized
into their own keys. TTL is applied per entity using the schema's
`ttl` (or `cache.defaultTTL`).

```ts
const result = await cache.writeEntity('post', {
  id: 1,
  title: 'Hello',
  content: 'World',
  author: { id: 9, name: 'Ada' },
  comments: [
    { id: 101, body: 'first', user: { id: 20, name: 'Bea' } },
    { id: 102, body: 'second', user: { id: 21, name: 'Cy' } },
  ],
});

// result is:
// {
//   success: true,
//   keys: ['post:1', 'user:9', 'comment:101', 'user:20',
//          'comment:102', 'user:21'],
//   operationId: 'op_<uuid>',
//   timestamp: 1777207682877
// }
```

**Concurrency**: under contention, each key independently retries up
to 5 times via CAS. After exhausting retries, throws
`InvalidOperationError` wrapping a `RedisConnectionError`. The caller
should retry at the request level.

**Partial updates**: omit fields you don't want to change. Smart-merge
preserves them. See [`NULL_UNDEFINED_HANDLING.md`](NULL_UNDEFINED_HANDLING.md).

### `readEntity(entityType, id, options?) → Promise<any | null>`

Hydrates the entity and (subject to options) its relations.

```ts
const post = await cache.readEntity('post', 1);
// {
//   id: 1, title: 'Hello', content: 'World',
//   author: { id: 9, name: 'Ada' },
//   comments: [
//     { id: 101, body: 'first', user: { id: 20, name: 'Bea' } },
//     { id: 102, body: 'second', user: { id: 21, name: 'Cy' } }
//   ]
// }
```

Returns `null` when the entity key doesn't exist. See
[Hydration options](#hydration-options) for `maxDepth`,
`selectiveFields`, and `excludeRelations`.

**Circular reference handling**: if hydration revisits an entity it's
currently traversing, the cache emits a stub like
`{ id: <id>, $ref: '<entityType>:<id>' }` instead of dropping the
reference silently. The `$ref` field is a public marker that survives
`stripInternalFields`. Callers can detect cycles and break recursion
themselves.

### `updateEntityIfExists(entityType, data) → Promise<WriteResult | null>`

Equivalent to `writeEntity`, but only when the primary entity already
exists in cache. Useful for cache-warm-only-on-read workflows where
admin updates shouldn't accidentally fill the cache.

```ts
await db.updateCategory(5, { name: 'New Name' });
const r = await cache.updateEntityIfExists('category', {
  id: 5, name: 'New Name', slug: 'new-name',
});
// r === null if the category isn't in cache; otherwise WriteResult.
```

**Race window**: between the `EXISTS` check and the actual write, the
key could be evicted. The CAS path used by `writeEntity` recovers
correctly either way; in the worst case a single related entity may
be cached briefly with no primary parent, which the next read
re-hydrates correctly.

### `deleteEntity(entityType, id) → Promise<boolean>`

Plain DEL on the entity key. Does **not** consult the membership
back-index. Use `invalidateEntity` instead when you want cascade
removal from tracked indexed lists.

Returns `true` if a key was deleted, `false` if it didn't exist.

### `invalidateEntity(entityType, id) → Promise<number>`

Atomic cascade invalidation:

1. Reads the membership back-index for the entity.
2. ZREMs the id from every tracked indexed list.
3. Deletes the entity key and the back-index.

All in one Lua script. Returns the number of indexed lists the entity
was removed from. For entities with no back-index (the common case),
returns 0 and behaves exactly like `deleteEntity`.

Use this whenever a row is deleted in your DB. Even if you're not yet
using `trackMembership`, calling `invalidateEntity` is the
forward-compatible choice; it costs the same as `deleteEntity` when
no membership exists.

---

## Plain list operations

### `writeList(listType, params, items) → Promise<ListWriteResult>`

Normalizes every item, atomically writes each entity, then writes the
list key as a JSON array of ids with the list's TTL.

```ts
const result = await cache.writeList('recentPosts', {}, [
  { id: 1, title: 'one', author: { id: 9, name: 'Ada' } },
  { id: 2, title: 'two', author: { id: 10, name: 'Bea' } },
]);
// {
//   success: true,
//   key: 'posts:recent',
//   ids: [1, 2],
//   operationId: 'op_<uuid>',
//   timestamp: 1777207682877
// }
```

`params` is whatever your `key(...)` function takes. Passing an
empty object is fine when the key is parameter-less.

### `readList(listType, params, options?) → Promise<any[]>`

Reads the JSON-array list, then batch-hydrates the entities. Returns
the resulting array in the order the ids appear in the list.

```ts
const posts = await cache.readList('recentPosts', {});
const titlesOnly = await cache.readList('recentPosts', {}, {
  maxDepth: 1,
  selectiveFields: ['title'],
});
```

Returns `[]` when the list key doesn't exist. Returns `[]` when the
stored value is malformed (e.g. not valid JSON or not an array) — the
cache logs a warning and returns empty rather than throwing.

### `addListItem(listType, params, entityData) → Promise<boolean>`

1. Writes the entity itself (full normalization).
2. Atomically appends the id to the list via Lua. Idempotent: if the
   id is already present, no write happens.

Returns `true` if the id was newly appended, `false` if it was a
duplicate. The list TTL is reapplied on every successful insert.

> **Note**: pass the **full entity object**, not just the id. The
> cache extracts the id via `entityData[listSchema.idField]`.

### `removeListItem(listType, params, entityId, options?) → Promise<boolean>`

Atomic Lua remove. The list's existing TTL is preserved (the script
reads the current TTL before rewriting).

```ts
await cache.removeListItem('recentPosts', {}, 2);
await cache.removeListItem('recentPosts', {}, 3, { deleteEntity: true });
```

When `deleteEntity: true`, the entity itself is also deleted via
`deleteEntity`. Returns `true` when the id was a member of the list.

### `deleteList(listType, params) → Promise<boolean>`

Plain DEL on the list key. Entities remain. Returns whether a key was
removed.

---

## Indexed list operations

All indexed-list methods are atomic Lua scripts on the Redis side. No
client-side races are possible.

### `writeIndexedList(listType, params, items) → Promise<ListWriteResult>`

Bulk upsert. Normalizes every item and writes entities + ZADDs in
parallel batches. **Does not clear existing members** — call
`deleteIndexedList` first for full-replace semantics.

```ts
await cache.writeIndexedList('globalFeed', {}, [
  { id: 1, title: 'a', createdAt: '2026-04-26T10:00:00Z', author: {...} },
  { id: 2, title: 'b', createdAt: '2026-04-26T11:00:00Z', author: {...} },
]);
```

Each ZADD is wrapped in the same Lua script that handles trim and
back-index, so atomicity is preserved per insert.

### `readIndexedList(listType, params, options?) → Promise<any[]>`

Paginated read. Returns at most `limit` (default 50) hydrated
entities.

Pagination options (in addition to standard hydration options):

| Option | Default | Meaning |
|---|---|---|
| `offset` | `0` | How many leading members to skip |
| `limit` | `50` | Maximum members to return |
| `reverse` | `false` | When true, returns highest-score first (e.g. newest-first for timestamp scores) |
| `minScore` / `maxScore` | `-Infinity` / `+Infinity` | Score range filter |

```ts
// Newest 50 posts in the global feed
const latest = await cache.readIndexedList('globalFeed', {},
  { limit: 50, reverse: true });

// Posts from a date range, oldest-first, only fields we care about
const start = new Date('2026-01-01').getTime();
const end = new Date('2026-04-01').getTime();
const archive = await cache.readIndexedList('globalFeed', {}, {
  minScore: start,
  maxScore: end,
  limit: 100,
  selectiveFields: ['id', 'title', 'createdAt'],
});
```

When the list doesn't exist or contains zero matching members,
returns `[]`. Entities that have been deleted (key gone) but still
have ids in the ZSET are filtered out of the result; you'll see a
shorter array than the raw id range. Use `invalidateEntity` (or
remove from the list explicitly) to keep ids in sync.

### `addIndexedListItem(listType, params, entityData) → Promise<boolean>`

1. Writes the entity (full normalization).
2. Resolves the score from `scoreField` (or `Date.now()`).
3. Atomically ZADDs to the list, applies trim if `maxSize` is set,
   updates the back-index if `trackMembership` is set, refreshes TTL.

Returns `true` when a new member was added, `false` when an existing
member's score was updated. Both outcomes are success.

### `removeIndexedListItem(listType, params, id, options?) → Promise<boolean>`

Atomic ZREM. The membership back-index is intentionally **not**
pruned here, because other lists may still reference the entity; that
cleanup happens in `invalidateEntity` or naturally via the back-index
TTL.

```ts
await cache.removeIndexedListItem('globalFeed', {}, 7);

// Remove from this list AND cascade-delete from every tracked list
await cache.removeIndexedListItem('globalFeed', {}, 7,
  { deleteEntity: true });
```

When `deleteEntity: true`, calls `invalidateEntity` after the ZREM,
which transitively removes the id from every other indexed list with
`trackMembership: true`.

### `indexedListSize(listType, params) → Promise<number>`

ZCARD. Returns 0 when the key doesn't exist.

### `deleteIndexedList(listType, params) → Promise<boolean>`

DEL on the ZSET key. Entities remain; back-index entries remain. They
are harmless and self-clean via TTL or future cascade invalidation.

---

## Write API call styles

Every write method accepts **two equivalent call shapes**. New code
should prefer the **object form** for readability and to avoid
positional mistakes; the positional form is preserved so existing
callers keep working without changes.

```ts
// Object form (recommended)
await cache.writeEntity({ entityType: 'post', data: postData });
await cache.writeList({ listType: 'recentPosts', params: {}, items });
await cache.addListItem({ listType: 'recentPosts', params: {}, entityData: post });
await cache.writeIndexedList({ listType: 'globalFeed', params: {}, items });
await cache.addIndexedListItem({ listType: 'globalFeed', params: {}, entityData: post });
await cache.updateEntityIfExists({ entityType: 'post', data: patch });

// Positional form (fully supported, unchanged semantics)
await cache.writeEntity('post', postData);
await cache.writeList('recentPosts', {}, items);
// ...etc
```

TypeScript overloads discriminate the two at compile time, so
intellisense shows the right shape for whichever you choose. Runtime
picks between them by inspecting whether the first argument is a
string (positional) or an object (new form).

### Per-call `ttl` override

Both call styles accept an optional `ttl` (seconds) that overrides
the schema TTL **for this write only**. Combined with `cascadeTTL`,
this gives you fully surgical TTL control without changing your
schema.

```ts
// Pin this post to 10 minutes, ignoring the schema's default.
await cache.writeEntity({ entityType: 'post', data: postData, ttl: 600 });

// Same thing positionally:
await cache.writeEntity('post', postData, { ttl: 600 });

// Pin a whole list for 24h, and ensure every embedded entity survives
// at least that long.
await cache.writeList({
  listType: 'globalFeed',
  params: {},
  items,
  ttl: 86400,
  cascadeTTL: true,
});

// Bump a single item's TTL when adding it to a feed:
await cache.addIndexedListItem({
  listType: 'globalFeed',
  params: {},
  entityData: post,
  ttl: 3600, // this post gets 1h even if the Post schema says 5 min
});
```

**Scope of `ttl` per method:**

| Method | `ttl` overrides |
|---|---|
| `writeEntity` / `updateEntityIfExists` | The root entity's TTL (the key `entityType:id`). Embedded relations keep their schema TTL unless `cascadeTTL: true` lifts them. |
| `writeList` / `writeIndexedList` | The list key's own TTL (and, with `cascadeTTL`, becomes the new cascade floor for embedded entities). |
| `addListItem` / `addIndexedListItem` | The **entity** being added (forwarded to `writeEntity`). The list key's TTL is deliberately **not** touched because the list is shared state that can't be per-item-overridden without surprising other writers. |

**Edge cases:**

- `ttl: 0` — treated as "no expiry" (Redis `PERSIST` semantics applied
  via the same code path as schema TTL 0). With `cascadeTTL: true`,
  this makes every child also never-expire, by design.
- `ttl: undefined` (or simply omitted) — falls back to schema TTL.
  This is the default and matches pre-override behaviour exactly.
- Negative / `NaN` `ttl` — ignored by the resolver; falls back to
  schema TTL. This is a defence against caller bugs; you should
  never pass these intentionally.

### Three TTL modes

There are three ways `ttl`, `cascadeTTL`, and `forceTTL` interact.
Pick the one that matches your intent — they cover every reasonable
TTL story.

| Mode | How to invoke | Root/list TTL | Embedded child TTL |
|---|---|---|---|
| **Default** (no flags) | `{ ttl: N }` | `N` (or schema TTL if omitted) | Each child's schema TTL |
| **Cascade floor** | `{ ttl: N, cascadeTTL: true }` | `N` (or schema TTL if omitted) | `max(child schema TTL, parent TTL)` — never demoted |
| **Force exact** | `{ ttl: N, forceTTL: true }` | `N` | Exactly `N` — overrides every child's schema TTL |

**When to use which:**

- **Default** — you want to pin one specific entity's TTL without
  touching its relations. Most common case.
- **Cascade floor** — your parent has a longer TTL than some embedded
  child (`Post: 1h` embeds `Category: 5min`). Without cascade, the
  child expires first and the parent reads back with `category: null`.
  Cascade lifts the child to at least the parent's TTL, fixing the
  coherence hole. **This is the safe default for nested writes.**
- **Force exact** — you want an explicit, uniform expiry across
  everything in this call: bulk-shorten for testing, manual cache
  shaping, matching an external eviction policy. `forceTTL` always
  wins over `cascadeTTL` (force is the stronger semantic).

```ts
// Default: short TTL on the post only; embedded category keeps its schema TTL.
await cache.writeEntity({ entityType: 'post', data: postData, ttl: 100 });

// Cascade floor: post 1h, embedded category bumped from 5min schema to 1h.
// Reading the post 30 min later still resolves the category.
await cache.writeEntity({
  entityType: 'post',
  data: postData,
  ttl: 3600,
  cascadeTTL: true,
});

// Force: every key in this batch gets exactly 100 seconds, including
// any embedded categories with longer schema TTLs.
await cache.writeList({
  listType: 'postList',
  params: { page: 1 },
  items: postList,
  ttl: 100,
  forceTTL: true,
});
```

> **Note on the cascade-floor invariant:** `cascadeTTL` is a *floor*,
> not an exact set. Passing `{ ttl: 100, cascadeTTL: true }` against
> a child whose schema TTL is 3600 keeps the child at 3600 — the
> floor doesn't lower a longer TTL because doing so would silently
> shorten cached data. If you really want to shorten everything,
> use `forceTTL: true`.

**Note also:** every successful write resets the TTL on the keys it
touches (Redis `SET ... EX` semantics, applied through the atomic CAS
Lua script). Calling `writeList` / `writeEntity` again on already-cached
keys *will* refresh those keys to whatever TTL the resolver picks for
this call. The resolver's choice is what the three modes above define.

---

## TTL cascade between parent and child entities

### The problem

Each entity in your schema has its own TTL. When you write a Post (TTL
3600) that embeds a Category (schema TTL 60), the Category key is
stored with TTL 60 — its own schema TTL, not the Post's. After 60
seconds the Category key expires while the Post key is still alive,
so reading the Post returns it with `category: null` (or the relation
absent). This is a real cache-coherence issue when parents are
longer-lived than the reference data they embed.

### The fix: opt-in `cascadeTTL` per write

Every write method accepts an optional `{ cascadeTTL?: boolean }` as
its last argument. When `true`, every entity written by that call
uses TTL = `max(its schema TTL, parentTtl)`, where `parentTtl` is:

- For `writeEntity` / `updateEntityIfExists`: the root entity's
  schema TTL.
- For `writeList` / `addListItem`: the list's schema TTL.
- For `writeIndexedList` / `addIndexedListItem`: the indexed list's
  schema TTL.

```ts
// Without cascadeTTL — Category gets its own short TTL.
await cache.writeEntity('post', postWithCategory);

// With cascadeTTL — Category gets max(60, 3600) = 3600 inside this
// write. Reading the Post 30 minutes later still resolves the Category.
await cache.writeEntity('post', postWithCategory, { cascadeTTL: true });

// Same option on every write method.
await cache.updateEntityIfExists('post', patch, { cascadeTTL: true });
await cache.writeList('recentPosts', {}, items, { cascadeTTL: true });
await cache.addListItem('recentPosts', {}, post, { cascadeTTL: true });
await cache.writeIndexedList('globalFeed', {}, items, { cascadeTTL: true });
await cache.addIndexedListItem('globalFeed', {}, post, { cascadeTTL: true });
```

### Edge cases the resolver handles correctly

| Scenario | Behaviour |
|---|---|
| `cascadeTTL: false` or omitted | Identical to prior versions; per-key schema TTL applies. |
| `parentTtl === 0` (parent never expires) | All children get TTL 0 too — they outlive a never-expiring parent. |
| Child's own schema TTL is 0 (explicitly persistent) | Left at 0, never demoted. |
| Child's TTL >= parentTtl already | Left unchanged. |
| `parentTtl` is `NaN` / negative (shouldn't happen) | Resolver falls back to per-key TTL; no surprise. |

### Two silent "No Limit" traps with `cascadeTTL`

Both of the following produce a Redis key with no TTL (shown as **"No Limit"**
in Redis tooling) even when `cascadeTTL: true` is set and the call looks
correct. Neither throws an error — they fail silently.

**Trap 1 — Schema name / key prefix mismatch**

The TTL resolver identifies an entity's schema by slicing the Redis key at the
**first `:`** and looking up what's to the left. When the schema is registered
under a name that differs from that prefix, the lookup returns `0`. The
cascade-floor guard (`if (ownTtl === 0) return 0`) then treats `0` as
"intentionally persistent" and the key is written with no TTL.

```
Schema registered as: 'pageCourse'
Key function produces: 'course:123'
Resolver extracts:     'course'  ← not found in schema registry
resolveEntityKeyTTL returns 0  →  cascade preserves 0  →  "No Limit"
```

Fix: keep every entity's schema name identical to the prefix its `key` function
produces (see [Key naming convention](#entity-schema)).

**Trap 2 — Missing schema TTL with `defaultTTL: 0`**

If an entity schema omits `ttl`, the resolver falls back to the engine's
`defaultTTL`. The internal default for `defaultTTL` is `0`. If your engine
config also does not set `cache.defaultTTL`, the resolver returns `0` for every
entity without an explicit schema TTL — and the cascade-floor guard again treats
that `0` as "no expiry".

Fix: always set `ttl` explicitly on entity schemas, **or** ensure your engine
config has a non-zero `cache.defaultTTL`:

```ts
new RedisGraphCache(schema, {
  cache: { defaultTTL: 3600 },
});
```

Do not rely on schema-level `ttl` being optional unless you have verified that
`cache.defaultTTL` is non-zero in your engine configuration.

### When to use it

**The simplest fix is to set the right TTLs in your schema in the
first place.** Reference data (Category, Tag, User profile) should
have a TTL ≥ the longest-lived parent that embeds it. The
`cascadeTTL` flag is for cases where:

- You can't easily change schema TTLs because other code paths rely
  on them being short.
- You want a short TTL on direct reads of the child entity (so it
  refreshes from DB regularly), but you don't want embedded copies
  to disappear from cached parents mid-flight.
- You're writing a long-lived feed (`indexedList` with TTL 24h) and
  want every entity in that feed to outlive a possible 1-hour TTL on
  the entity schema.

### What `cascadeTTL` does NOT do

- It does not affect entities that already exist in cache and are
  not touched by this write. The next write that does touch them
  (without `cascadeTTL`) will revert them to schema TTL.
- It does not refresh TTLs on read. Reading a Post does not bump the
  Category's TTL. If the Category's TTL hasn't been touched by a
  cascading write recently, it will still expire on its schema TTL.
- It does not propagate transitively to entities written by *separate*
  calls. If your write of a Post touches an Author, and the Author's
  schema later does its own write of an Address, that second write
  does not inherit the Post's TTL.

### Why it's not the default

Making cascade implicit silently overrides deliberate short TTLs on
shared reference data. A Category configured with TTL 60 because you
want it to be re-read from DB every minute would effectively live as
long as the longest-TTL Post that referenced it. That's a worse
default than the current explicit short-TTL-wins behaviour.

---

## Cache management & invalidation

### Recommended invalidation pattern

```ts
async function deletePost(id: number) {
  await db.posts.delete(id);
  await cache.invalidateEntity('post', id);
  // ↑ atomically removes from every indexed list with trackMembership
}

async function updatePost(id: number, patch: Partial<Post>) {
  const updated = await db.posts.update(id, patch);
  await cache.updateEntityIfExists('post', updated);
  // ↑ refreshes the cache only if the entity was already cached
}
```

For plain `list` schemas (no membership index), you must explicitly
invalidate any list keys that reference the deleted entity:

```ts
await cache.deleteList('recentPosts', {});
await cache.deleteList('userPosts', { userId });
```

This is the main reason to prefer `indexedList` with `trackMembership:
true` for any list that tracks deletable entities.

### `clearAllCache(opts) → Promise<void>`

Destructive. Behaviour depends on whether `redis.keyPrefix` is set:

| Config | What runs | Scope |
|---|---|---|
| `keyPrefix` set | `SCAN` + `UNLINK` in batches of 500 | Only keys starting with the prefix; other apps/envs on the same DB untouched. |
| `keyPrefix` empty | `FLUSHDB` | Wipes the entire selected Redis DB. Only use when this cache owns the whole DB. |

Two safeguards apply in both modes:

1. The caller **must** pass `{ confirm: 'YES_WIPE_ALL' }` exactly.
2. When `safety.productionMode` is true, also pass
   `{ allowProduction: true }`.

```ts
// Dev / test only
await cache.clearAllCache({ confirm: 'YES_WIPE_ALL' });

// Production (rare; usually a script, not application code)
await cache.clearAllCache({
  confirm: 'YES_WIPE_ALL',
  allowProduction: true,
});
```

Without these the call throws `InvalidOperationError`. This makes it
much harder to accidentally wipe a database from a test harness or a
mis-targeted CLI invocation.

**Why `SCAN` + `UNLINK` instead of `FLUSHDB` when a prefix is set:**

- `FLUSHDB` is synchronous on the Redis server and blocks other
  traffic on large keyspaces. `UNLINK` releases memory asynchronously
  in a background thread.
- `FLUSHDB` deletes **everything** in the DB, including keys owned by
  other applications or environments sharing that DB. Scoped delete
  touches only this cache's keys.
- `SCAN` is cursor-based and non-blocking; Redis guarantees it won't
  miss keys that exist for the full duration of the scan.

### Key namespacing

All reads, writes, and Lua-script invocations go through ioredis'
`keyPrefix` option, which transparently prepends the configured
prefix to every key on the wire. You do **not** change your schema or
your call sites; the prefix is applied per client, so `post:42`
becomes `mygouripur:post:42` in Redis without any code change.

**When to set a prefix:**

- You share a Redis instance between staging and production — use
  different prefixes per environment (`mygouripur:prod:`,
  `mygouripur:staging:`).
- You share a Redis instance with other services. A prefix prevents
  collisions with their keys and makes your keyspace easy to isolate.
- You plan to distribute this as an npm library. Every consumer can
  set their own prefix; your library never collides with theirs.
- You want `clearAllCache` to only wipe your app's keys — setting a
  prefix flips the internal implementation to scoped `SCAN` + `UNLINK`.

**Recommended format:** `"<app>:"` or `"<app>:<env>:"`. Keep it short;
it is stored on every key.

**Trailing `:` is automatic.** If you pass a non-empty prefix that
doesn't end in `:`, the cache appends one for you so the prefix and
the entity type don't run together. `keyPrefix: 'mygouripur'` is
silently normalized to `'mygouripur:'`, producing keys like
`mygouripur:post:42` rather than the accidental `mygouripurpost:42`.
Pass the trailing `:` yourself if you want any other separator
character (the cache only normalizes the missing-`:` case).

**Migration:** if you turn on a prefix against an existing database,
old (unprefixed) keys become invisible to the cache and will
eventually expire via their TTLs. If you want to delete them
immediately, run one `FLUSHDB` with the prefix disabled before cutting
over. There is no in-place "rename" for existing keys — Redis doesn't
support that at scale.

---

## Connection pool

When `redis.poolSize > 1`, the cache maintains N independent ioredis
clients against the same Redis instance and round-robins commands
across them. Each client:

- Has its own TCP socket
- Has all atomic Lua scripts pre-registered
- Emits its own connect / error / close events into the shared metrics

**Why use it**: a single ioredis client serializes commands on its
socket. Under sustained high concurrency this becomes a head-of-line
bottleneck. Multiple clients give Redis a chance to use its own
parallelism.

**When NOT to use it**: at low traffic (a few hundred ops/sec or
less) the extra connections waste resources. Default of 1 is the
right choice for most apps.

**Sizing**:

| Sustained ops/sec | Recommended `poolSize` |
|---|---|
| < 1k | 1 (default) |
| 1k–10k | 4 |
| 10k–30k | 8 |
| 30k+ | 16 |

Going much higher than 16 rarely helps and consumes Redis connection
slots (default Redis `maxclients` is 10,000).

**Atomicity is preserved across the pool.** All Lua scripts are
single-key (or two related keys for cascade invalidation). Atomicity
is a Redis-side property of the script execution; it doesn't matter
which client connection issued it.

---

## Serialization (lossless by default)

Entity payloads round-trip through a pluggable `Serializer` that
preserves JS types raw `JSON.stringify` cannot represent natively.
The default serializer (`TAGGED_SERIALIZER`) is enabled
automatically — no config required.

Types preserved across cache round-trips:

| JS type | Schema `type` | Without (raw JSON) | With default serializer |
|---|---|---|---|
| `string` | `'string'` | string | string |
| `number` | `'number'` | number | number |
| `boolean` | `'boolean'` | boolean | boolean |
| plain object | `'object'` | object | object |
| array | `'array'` | array | array |
| `Date` | `'date'` | ISO string | `Date` instance |
| `BigInt` | `'bigint'` | **throws** `TypeError` | `BigInt` |
| `Map` | `'map'` | `{}` (data lost) | `Map` |
| `Set` | `'set'` | `{}` (data lost) | `Set` |
| `RegExp` | `'regexp'` | `{}` (data lost) | `RegExp` |
| `Buffer` | `'buffer'` | `{type:"Buffer",data:[...]}` | `Buffer` |
| `NaN`, `±Infinity` | `'number'` | `null` | original number |

### Field `type` is advisory, not coercive

The `type` you declare in `fields` exists for documentation and to
catch obvious typos at schema registration (`type: 'stirng'` will
fail validation). **The cache does not coerce values based on it.**
What you write is what you read back:

```ts
// Schema says 'date', but you pass a string:
fields: { createdAt: { type: 'date' as const } },
data:   { createdAt: '2026-04-26T10:00:00Z' }

// On read you get back a STRING, not a Date — because you wrote
// a string. The serializer only transforms values whose JS type
// is special (Date, BigInt, Map, ...). Strings round-trip as strings.
```

To actually get a `Date` back on read, you must **write a `Date`**:

```ts
fields: { createdAt: { type: 'date' as const } },
data:   { createdAt: new Date('2026-04-26T10:00:00Z') }

// On read: createdAt is a Date instance.
```

This is a deliberate design choice: the cache is a cache, not a
validator. Runtime coercion would hide bugs where producers and
consumers disagree about the wire format.

Types intentionally **not** tagged (cache semantics):

- `undefined` — kept identical to "field omitted" so the merge logic
  doesn't accidentally clobber existing values on partial updates.
  See `NULL_UNDEFINED_HANDLING.md`.

Backward compatibility:

- Reads of plain JSON written by older versions or other producers
  work unchanged. The reviver only transforms objects that carry the
  internal tag key.
- Writes that contain only JSON-native values produce byte-for-byte
  identical output to plain `JSON.stringify`, so on-wire format is
  unchanged for ordinary data.

Opting out / plugging in another codec:

```ts
import {
  RedisGraphCache,
  JSON_SERIALIZER,
  type Serializer,
} from 'redis-graph-cache';

// Opt out: original behaviour, fastest, but lossy for the types above.
new RedisGraphCache(schema, {
  cache: { serializer: JSON_SERIALIZER },
});

// Plug in superjson (or devalue, cbor-x, etc.):
import superjson from 'superjson';
const codec: Serializer = {
  stringify: (v) => superjson.stringify(v),
  parse: (s) => superjson.parse(s),
};
new RedisGraphCache(schema, {
  cache: { serializer: codec },
});
```

Note: list bodies (the JSON id-array stored under a `list` schema's
key) are intentionally **not** routed through the serializer because
Lua scripts on the Redis side parse them directly. Lists always use
plain JSON. Only entity values pass through the serializer.

---

## Compression

Opt-in zlib compression for entity values, transparent at the
read/write boundary. Off by default.

Enable via:

```ts
new RedisGraphCache(schema, {
  cache: {
    enableCompression: true,
    compressionThreshold: 4096, // bytes
  },
});
```

**What gets compressed**: only entity values written by the
normalization path. Plain `list` JSON-array values, `indexedList`
ZSETs, and the membership back-index are **not** compressed (their
shape is consumed by Lua scripts on the Redis side, which can't
inflate compressed payloads).

**Format**: compressed values are stored as a string with the prefix
`\x00z1:` followed by base64-encoded `deflateRaw` output. Plain JSON
values (which always start with `{` or `[`) are stored unchanged.

**Backward compatibility**: enabling compression on a cache that
already contains uncompressed entities is safe. Reads detect the
prefix and only decompress tagged values. Disabling compression later
is also safe — uncompressed writers can still read previously
compressed values, and vice versa.

**Threshold**: payloads smaller than `compressionThreshold` bytes are
not compressed because the base64 envelope overhead would be a net
loss. The minimum threshold is clamped at 64 bytes.

**When to enable it**: typical posts with comments are 2–10 KB. At
that size compression saves ~50% of memory and bandwidth, which
matters once you have ≥100k entities or run on a paid Redis with a
memory cap. It is **not** a correctness or scaling fix; it's a
storage cost optimization.

---

## Monitoring & health

### `getMetrics() → CacheMetrics`

Returns real counters, not stubs. Every Redis command updates the
relevant fields.

```ts
const m = cache.getMetrics();
// {
//   cacheHits, cacheMisses, hitRate,        // GET/MGET observed
//   totalOperations, avgResponseTime,        // every command
//   activeConnections,                       // 1 if any pool client up
//   failedOperations,
//   memoryUsage: 0,                          // cache-side; reserved
//   lastUpdated
// }
```

`hitRate` is in the range `0..1`, rounded to 3 decimal places. It is
0 when no GET/MGET has been issued yet.

### `getHealthStatus() → Promise<HealthStatus>`

Issues a real PING and reports aggregate health.

```ts
const h = await cache.getHealthStatus();
// {
//   status: 'healthy' | 'degraded' | 'unhealthy',
//   redis: {
//     connected: true,
//     latency: 2,             // ms; running average
//     memoryUsage: 1234567    // bytes; from INFO memory used_memory
//   },
//   cache: {
//     activeOperations: 5,    // currently in-flight cache calls
//     memoryUsage: 0,         // reserved
//     errorRate: 0.001        // failed / total
//   },
//   timestamp: 1777207682877
// }
```

Status mapping:
- `unhealthy` — PING failed.
- `degraded` — error rate above 5% **or** circuit breaker non-CLOSED.
- `healthy` — neither of the above.

### `enableDebugMode(enabled: boolean): void`

Sets a flag in the monitoring config. The library does not currently
emit verbose debug logs itself; this is provided as a hook for
consumers and middlewares.

---

## Hydration options

These apply to `readEntity`, `readList`, and `readIndexedList`:

| Option | Type | Default | Effect |
|---|---|---|---|
| `maxDepth` | `number` | `5` (cache config) | Depth limit for recursive relation hydration |
| `memoryLimit` | `number` | `100 * 1024 * 1024` | Hard cap on in-memory hydration size |
| `selectiveFields` | `string[]` | undefined | Restrict each entity in the result to only these fields (plus the id field). Internal `__rse_*` markers are kept internally so relations still resolve. |
| `excludeRelations` | `string[]` | undefined | Skip the listed relations during hydration. Pass `['*']` to skip all relations entirely. |

Indexed-list reads also accept ZSET-specific options (`offset`,
`limit`, `reverse`, `minScore`, `maxScore`) — see
[Indexed list operations](#indexed-list-operations).

---

## Error model

All thrown errors extend `RedisSchemaEngineError`, which adds a
typed `type` enum, a `requestId`, and a `toJSON()` for safe logging.

| Error class | When |
|---|---|
| `SchemaValidationError` | Bad schema at construction time |
| `EntityNotFoundError` | Reserved; not currently thrown by reads (they return `null`) |
| `InvalidOperationError` | Wrong call shape, missing required field, refused destructive op |
| `RedisConnectionError` | Underlying Redis command failed after retries |
| `MemoryLimitError` | Hydration exceeded the per-request memory cap |
| `CircuitBreakerOpenError` | Hot-path call refused because the breaker is OPEN |
| `HydrationDepthExceededError` | Recursion exceeded `maxDepth` |

Every error carries a `requestId` (UUID) you can correlate with logs.

```ts
try {
  await cache.writeEntity('post', { /* missing id */ });
} catch (err) {
  if (err instanceof InvalidOperationError) {
    console.error(err.requestId, err.context);
  }
  throw err;
}
```

---

## Atomicity & concurrency contract

| Operation | Atomicity | Notes |
|---|---|---|
| `writeEntity` | Per normalized key, atomic via CAS-with-retry | Concurrent partial updates converge |
| `updateEntityIfExists` | EXISTS check + CAS write | Brief race window where key may be evicted between EXISTS and CAS; CAS handles it correctly |
| `writeList` | Per-entity atomic; list-key write is independent | Two concurrent `writeList` calls overlap on the list key |
| `addListItem` / `removeListItem` | Atomic Lua | Idempotent add; safe under contention |
| `writeIndexedList` (per insert) | Atomic Lua | Trim + back-index in same script |
| `addIndexedListItem` / `removeIndexedListItem` | Atomic Lua | Membership tracking applied in-script |
| `invalidateEntity` | Atomic Lua cascade | Reads back-index, ZREMs from each tracked list, deletes entity + back-index |
| `clearAllCache` (no prefix) | Single FLUSHDB | Guarded by required confirm + production block |
| `clearAllCache` (prefix set) | SCAN + UNLINK | Non-blocking; only touches keys under the configured prefix |

What is **not** atomic:
- A `writeList` call writing the same list key concurrently with
  another `writeList` call. The list value may end up reflecting
  either writer's id list.
- Sequences of operations (e.g. "update post then add to feed") —
  cross-key transactions are out of scope.
- Cache invalidation across application instances — it's the
  application's responsibility to call `invalidateEntity` from every
  process that mutates the underlying data.

---

## Operational guidance

### Sizing Redis

For ~100k entities at typical sizes, plan for ~1-2 GB RAM. For 1M
entities, 8-16 GB. Compression cuts these roughly in half for typical
workloads. Redis Insights / `INFO memory` will tell you the truth
about your specific data.

Set `maxmemory-policy` to `allkeys-lru` if you can tolerate
cache-only data being evicted under memory pressure. If your cache
holds anything that is the source of truth (it shouldn't, but make
sure), use `noeviction` and monitor `used_memory_peak` carefully.

### Cache stampede protection

When a hot key expires, every concurrent reader misses the cache and
hits your database. The cache doesn't deduplicate these requests.
Add request coalescing at your service layer — for example using a
small in-process map of "in-flight DB fetches" keyed by entity id.

### Choosing list flavour

| Use `list` when… | Use `indexedList` when… |
|---|---|
| The list is short (≤ a few hundred ids) | The list may grow large |
| You always read the whole list | You need pagination |
| Insertion order is enough | You need sorting by score |
| You don't need cascade invalidation | You want `trackMembership` |

If in doubt, prefer `indexedList`. The overhead is modest and it
scales without surprise.

### Cluster mode (not supported)

The cache is designed for a single Redis instance (which can include
a primary with replicas, but a single keyspace). Hash-tagging,
slot-aware MGET batching, and cluster-aware pipelining are not
implemented. Do not deploy this against Redis Cluster as-is.

### PM2 cluster mode (recommended for high concurrency)

For sustained workloads above ~30k ops/sec on one Node process,
sync `JSON.parse` on the event loop becomes the bottleneck — not
Redis. Run multiple Node processes behind a load balancer (PM2
`exec_mode: 'cluster'`, Kubernetes pods, etc.). Each process opens
its own pool. This is the standard, free way to add CPU parallelism
to a Node app and is more effective than off-thread JSON inside
the library.

---

## Migration notes

If you're upgrading from the pre-`cascadeTTL` / pre-`safety` /
pre-scoped-clear versions:

0. **No code changes are required.** All three features are additive.
   Existing call sites compile and run unchanged.
0. **`clearAllCache` now uses SCAN + UNLINK when `keyPrefix` is set.**
   If a test fixture relied on it wiping the entire DB (including
   keys written by raw ioredis or another cache), either unset the
   prefix for that test, or call `FLUSHDB` directly via
   `connectionManager.getRawClient().flushdb()` from your teardown.
   Application code is unaffected.
0. **Set a prefix if you share Redis.** For any production deployment
   sharing Redis with another app or environment, configure
   `redis.keyPrefix` to isolate this cache's keyspace and make
   `clearAllCache` safe by construction.
0. **`safety.productionMode` defaults from `NODE_ENV`** at cache
   construction time. If you don't pass `safety` in your config, your
   `clearAllCache` guard behaves identically to before. Library
   consumers should pass it explicitly to drop the env coupling.
0. **Adopt `cascadeTTL: true` selectively** on writes where the
   parent's TTL is meaningfully longer than its embedded reference
   data. The simplest alternative is to raise the schema TTL of the
   reference entity to match the longest-lived parent — that costs
   nothing extra at write time.

If you're upgrading from the pre-atomic implementation:

1. **Existing cached values stay readable.** Compression is opt-in
   and the new connection pool defaults to 1 (single client).
2. **`clearAllCache()` now requires explicit confirmation.** Update
   any test fixtures that called it without arguments.
3. **`invalidateEntity()` now returns a number** (the count of
   tracked lists the entity was removed from). Existing
   `await cache.invalidateEntity(...)` calls that ignore the return
   value continue to work.
4. **`getMetrics()` returns real numbers.** If you had asserts on
   the old hardcoded zeros, update them.
5. **List values that were written without TTL** keep working until
   manually deleted. New writes apply the schema's `ttl` (or
   `cache.defaultTTL`) automatically.
6. **`selectiveFields` now actually restricts the output.** Any code
   that was relying on the old broken behaviour (where the option
   was a no-op) needs review.
7. **Circular references now emit a `$ref` marker** rather than
   silently dropping data. Hydration consumers should handle the
   `$ref` field if they walk relation graphs.

No automatic data migration is required to take advantage of any of
the new features. Adopt them incrementally:

1. Turn on the connection pool first if you have concurrency pain
   (`poolSize: 8`).
2. Convert one list at a time to `indexedList` as needed.
3. Enable compression last, with a generous threshold (e.g. 4 KB),
   after the rest is stable.

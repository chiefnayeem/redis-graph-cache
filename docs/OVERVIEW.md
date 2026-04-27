# Redis Graph Cache

A TypeScript-first Redis caching layer for Node.js applications that
need schema-driven normalization, atomic concurrent writes,
ZSET-backed paginated lists, automatic relationship hydration, and
graceful resilience under failure.

This document is the entry point. For the full reference, see
[`USAGE.md`](USAGE.md).
For details on `null`/`undefined` semantics, see
[`NULL_UNDEFINED_HANDLING.md`](NULL_UNDEFINED_HANDLING.md).

---

## What it does

- **Schema-driven storage** — Declare entities and relationships once;
  the cache handles normalization, hydration, and key generation.
- **Atomic writes via Lua** — Every read-modify-write path (smart
  merge, list add/remove, indexed-list mutations, cascade invalidation,
  conditional set-if-exists) is implemented as a single Lua script so
  concurrent writers cannot lose each other's updates.
- **Two list flavours**, side by side:
  - `list` (plain JSON array of ids) — minimal-overhead, fine for short
    admin lists, kept for backward compatibility.
  - `indexedList` (ZSET-backed) — paginated reads, sorted by any
    numeric or timestamp field, atomic add/remove, optional max-size
    trim, optional cascade invalidation.
- **TTL** — Both schema-level (`ttl`) and library-default
  (`cache.defaultTTL`) are honoured on every write.
- **Connection pool** — Internal round-robin across N ioredis clients
  (default 1) for higher throughput at high concurrency.
- **Optional payload compression** — Opt-in zlib for large entity
  values, transparent at read/write boundaries, backward-compatible
  with un-compressed cached data.
- **Resilience** — Circuit breaker, retry with exponential backoff,
  real cache hit/miss/latency metrics, real Redis-side memory reporting.
- **Safe destructive ops** — `clearAllCache` requires explicit
  confirmation and refuses to run in production unless explicitly told
  it is allowed.

---

## What it is **not** suitable for (yet)

Be honest with yourself before deploying:

- **Redis Cluster** is not supported. Single-instance Redis only.
  Hash-tagging, slot-aware MGET/pipelines, and replica routing are not
  implemented.
- **Off-thread JSON** is not implemented. At very high throughput
  (~50k+ ops/sec on one Node process) sync `JSON.parse` will become
  the bottleneck. The standard fix is PM2 cluster mode (multiple
  Node processes), not a library change.
- **Cache stampede protection** is not implemented. If a hot key
  expires under load, every concurrent reader will fall through to
  your DB at once. Add request coalescing at your service layer.
- **No automatic invalidation graph for plain `list` schemas.** Use
  `indexedList` with `trackMembership: true` for entity-to-list
  cascade invalidation, or hand-roll list invalidation in your DB
  mutation paths.

---

## Realistic operating envelope

Single Redis instance, single-instance Node application:

| Workload | Status |
|---|---|
| Up to ~5k concurrent users, ~100k entities, JSON-array lists with up to a few thousand items | Comfortably supported |
| Up to ~20k concurrent users with `indexedList` + connection pool | Supported once you've measured and sized Redis appropriately |
| Up to ~50k concurrent users with `indexedList`, connection pool size 8-16, compression on for large payloads | Achievable, requires capacity planning + monitoring + cache stampede protection at the service layer |
| 50k+ users sustained on a single Redis | Not supported by this library; would require Redis Cluster work |

These numbers assume a reasonable Redis instance (8-16+ GB RAM, low
network latency to the app) and a reasonable post/comment payload
size (1-10 KB). Larger payloads or heavier hydration depths cut these
numbers.

The library cannot guarantee any of this on its own. Capacity, sizing,
monitoring, runbooks, and load testing are operational work that lives
outside the cache layer.

---

## Quick start

```ts
import { RedisGraphCache } from 'redis-graph-cache';

// 1. Declare schema. Use 'entity' for objects, 'list' for small JSON-array
//    collections, and 'indexedList' for paginated/sorted ZSET-backed feeds.
const schema = {
  post: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `post:${id}`,
    fields: {
      title: { type: 'string' as const },
      content: { type: 'string' as const },
      createdAt: { type: 'string' as const },
    },
    relations: {
      author: { type: 'user', kind: 'one' as const },
      comments: { type: 'comment', kind: 'many' as const },
    },
    ttl: 3600, // seconds
  },
  user: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `user:${id}`,
    fields: { name: { type: 'string' as const } },
    ttl: 7200,
  },
  comment: {
    type: 'entity' as const,
    id: 'id',
    key: (id: string | number) => `comment:${id}`,
    fields: { body: { type: 'string' as const } },
    ttl: 1800,
  },
  // Plain JSON-array list — fine for short collections.
  recentPosts: {
    type: 'list' as const,
    entityType: 'post',
    key: () => 'posts:recent',
    idField: 'id',
    ttl: 600,
  },
  // ZSET-backed list for the global feed. Sorted by createdAt descending,
  // capped at 10k members, cascade-invalidates on post deletion.
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

// 2. Instantiate.
const cache = new RedisGraphCache(schema, {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: 6379,
    poolSize: 8, // optional; default 1
  },
  cache: {
    defaultTTL: 3600,
    enableCompression: true,
    compressionThreshold: 4096,
  },
});

// 3. Use it.
await cache.writeEntity('post', {
  id: 1,
  title: 'Hello',
  content: 'World',
  createdAt: '2026-04-26T12:00:00Z',
  author: { id: 9, name: 'Ada' },
});

// Atomic add to the global feed (writes entity, ZADD, trims, tracks).
await cache.addIndexedListItem('globalFeed', {}, {
  id: 2,
  title: 'Second',
  createdAt: '2026-04-26T12:05:00Z',
  author: { id: 9, name: 'Ada' },
});

// Paginated read, newest-first.
const latest = await cache.readIndexedList('globalFeed', {}, {
  limit: 50,
  reverse: true,
});

// Cascade-invalidate: removes the entity AND ZREMs from every tracked
// indexed list it appears in, atomically.
await cache.invalidateEntity('post', 1);

// Real metrics (no fake zeros).
console.log(cache.getMetrics());
// {
//   cacheHits, cacheMisses, hitRate, totalOperations, avgResponseTime,
//   memoryUsage: 0, activeConnections, failedOperations, lastUpdated
// }

// Health
console.log(await cache.getHealthStatus());

// Shutdown
await cache.disconnect();
```

---

## Atomicity contract (what is and isn't atomic)

| Operation | Atomicity |
|---|---|
| `writeEntity` (per key) | **Atomic** — CAS-with-retry per normalized key. Concurrent writers do not lose each other's updates. |
| `writeList` (across N items) | Per-key atomic per item; the list-key write is independent. Two concurrent `writeList` calls writing the same list key may overlap. |
| `addListItem` / `removeListItem` (JSON-array list) | **Atomic** — single Lua script. Concurrent adds and removes converge correctly. |
| `addIndexedListItem` / `removeIndexedListItem` (ZSET list) | **Atomic** — single Lua script. Trim and back-index update happen in the same script. |
| `invalidateEntity` (cascade) | **Atomic** — single Lua script reads the back-index, ZREMs from every tracked list, deletes the entity and the back-index. |
| `clearAllCache` | Atomic FLUSHDB. Guarded by required `confirm` argument and a production-mode block. |

---

## Resilience guarantees

- **Every command flows through the circuit breaker + retry wrapper.**
  When the breaker is OPEN, hot-path operations fail fast with
  `CircuitBreakerOpenError` rather than queueing on a dead Redis.
- **Connection pool** (when `poolSize > 1`) tolerates partial failures.
  Health is "OR" across pool members; one bad socket doesn't take the
  cache down.
- **Retry budget is bounded.** No path retries forever. CAS contention
  retries up to 5 times before surfacing a `RedisConnectionError`,
  which the caller can retry at the request level.
- **Backward-compatible reads.** Compression and connection-pool changes
  do not invalidate existing cached data.

---

## Configuration reference (summary)

| Path | Default | Purpose |
|---|---|---|
| `redis.host` / `redis.port` | `localhost` / `6379` | Connection target |
| `redis.poolSize` | `1` | Number of ioredis clients in the round-robin pool |
| `redis.keyPrefix` | `''` | Namespace every key (e.g. `'mygouripur:'`). When set, `clearAllCache` switches from `FLUSHDB` to non-blocking scoped `SCAN` + `UNLINK`. Strongly recommended when sharing Redis with other apps/envs. |
| `redis.password`, `redis.db`, `redis.connectTimeout`, etc. | passed through to ioredis | All ioredis options accepted |
| `limits.maxHydrationDepth` | `5` | Max recursion depth during hydration |
| `limits.maxMemoryUsagePerOperation` | `100 * 1024 * 1024` | Cap on per-request hydrated memory (bytes) |
| `resilience.circuitBreaker.threshold` | `5` | Failures before breaker opens |
| `resilience.retry.maxAttempts` | `3` | Per-command retry budget |
| `cache.defaultTTL` | `3600` | Fallback TTL when schema doesn't specify one |
| `cache.enableCompression` | `false` | Opt-in zlib compression for entity values |
| `cache.compressionThreshold` | `1024` | Don't compress payloads smaller than this many bytes |
| `safety.productionMode` | `process.env.NODE_ENV === 'production'` | When true, `clearAllCache` requires `allowProduction: true`. Override explicitly for npm consumers. |
| `monitoring.enableDebugMode` | `false` | Verbose logging hook (consumer-driven) |

Per-call write options (every write method accepts both an object form,
e.g. `writeEntity({ entityType, data, ttl, cascadeTTL })`, and the
original positional form for backward compatibility):

| Option | Where | Effect |
|---|---|---|
| `ttl: number` (seconds) | All 6 write methods | Overrides the schema TTL for this write only. Scope is the root entity for `writeEntity` / `updateEntityIfExists` / `addListItem` / `addIndexedListItem`, and the list key for `writeList` / `writeIndexedList`. See [USAGE](USAGE.md#write-api-call-styles). |
| `cascadeTTL: true` | All 6 write methods | Embedded child entities use TTL = `max(schema TTL, parent TTL)` for this write only. Combines with `ttl` — when both are set, the override becomes the cascade floor. See [USAGE](USAGE.md#ttl-cascade-between-parent-and-child-entities). |
| `forceTTL: true` | All 6 write methods | Every key in the call (root + every embedded relation) is set to exactly `ttl`, ignoring schema TTLs and cascade rules. Use when you want a uniform, explicit expiry across the whole write (bulk-shorten, testing, manual shaping). Wins over `cascadeTTL` if both are set. See [USAGE](USAGE.md#three-ttl-modes). |

For the full list, see [`USAGE.md`](USAGE.md#configuration).

---

## Honest reading guide

If you're evaluating whether to deploy this:

1. **Read [`USAGE.md`](USAGE.md) end to end** — every method has a
   semantics paragraph, return type, and edge cases documented.
2. **Run a smoke test against a local Redis** before relying on this
   in any environment that matters. The library is type-clean and
   internally consistent, but no integration test suite ships with it.
3. **Pick one read path and migrate it first.** Don't flip the whole
   app over to the indexed-list type in one PR.
4. **Wire `getMetrics()` into your observability stack** before traffic
   ramps. Hit rate is the only honest signal of whether the cache is
   actually paying off.

---

## License

MIT

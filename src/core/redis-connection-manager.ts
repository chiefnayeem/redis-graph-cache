/**
 * Redis Connection Manager
 *
 * Owns the ioredis client and exposes a small set of typed methods that all
 * Redis traffic flows through. Every call goes through a circuit breaker +
 * retry wrapper, records latency, and updates cache hit/miss counters where
 * applicable. Atomic Lua scripts are registered on construction and exposed
 * as typed helpers (casSet, setIfExists, listAdd, listRemove) so callers
 * never need direct access to the underlying client for normal work.
 */

import Redis, { Redis as RedisInstance, ChainableCommander } from 'ioredis';
import {
  RedisConfig,
  CircuitBreakerConfig,
  RetryConfig,
  CircuitBreakerState,
  RetryOptions,
  RedisConnectionError,
  CircuitBreakerOpenError,
} from '../types';
import { SCRIPT_DEFINITIONS } from './lua-scripts';

/**
 * ioredis-extended client surface used internally. Each `rse*` method
 * is a Lua script registered via `defineCommand` (see lua-scripts.ts);
 * every script returns a single integer status code, hence `number`.
 *
 * `zrangebyscore` / `zrevrangebyscore` exist on the base `RedisInstance`
 * type, but their overload set doesn't accept a spread `unknown[]` of
 * mixed strings/numbers, which is what we build at the call site. We
 * re-declare them here with a spread-friendly signature so callers
 * don't need an `as any` cast.
 */
type ScriptedRedis = RedisInstance & {
  rseCasSet(
    key: string,
    expectedValue: string,
    newValue: string,
    ttlSeconds: string,
  ): Promise<number>;
  rseSetIfExists(
    key: string,
    value: string,
    ttlSeconds: string,
  ): Promise<number>;
  rseListAdd(
    listKey: string,
    id: string,
    ttlSeconds: string,
    numericFlag: string,
  ): Promise<number>;
  rseListRemove(listKey: string, id: string): Promise<number>;
  rseZListAdd(
    listKey: string,
    membershipKey: string,
    score: string,
    id: string,
    ttlSeconds: string,
    maxSize: string,
    trackMembership: string,
  ): Promise<number>;
  rseZListRemove(
    listKey: string,
    membershipKey: string,
    id: string,
    trackMembership: string,
  ): Promise<number>;
  rseCascadeInvalidate(
    membershipKey: string,
    entityKey: string,
    id: string,
  ): Promise<number>;
  zrangebyscore(...args: (string | number)[]): Promise<string[]>;
  zrevrangebyscore(...args: (string | number)[]): Promise<string[]>;
};

export class RedisConnectionManager {
  /**
   * The pool of ioredis clients. Default size 1 (a single connection)
   * for backward compatibility. When `redis.poolSize` is configured
   * higher, every hot-path command is round-robined across these
   * clients, giving genuine parallelism on the Redis socket.
   */
  private clients: RedisInstance[] = [];
  private rrIndex: number = 0;
  /**
   * Per-client connected flags. `isConnected` (below) is the OR across
   * the pool, so health checks succeed when *any* client is up.
   */
  private connectedFlags: boolean[] = [];
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private healthMetrics: HealthMetrics;

  /**
   * Typed view of `this.redis` that includes the Lua-script methods
   * registered via `defineCommand`. Use this whenever you need to
   * call an `rse*` script or a variadic ZRANGEBYSCORE-family command;
   * ordinary commands (`get`, `set`, `del`, `exists`, etc.) are typed
   * on the base instance and should keep using `this.redis`.
   *
   * Calling this advances the round-robin index identically to
   * `this.redis`, so a single call site stays pinned to one client.
   */
  private get scripted(): ScriptedRedis {
    return this.redis as ScriptedRedis;
  }

  /**
   * Round-robin client picker. Hot-path methods read `this.redis` once
   * per call which advances the index, distributing load uniformly.
   * Pipelines obtained via `this.redis.pipeline()` are owned by a
   * single client because the getter is called exactly once.
   */
  private get redis(): RedisInstance {
    if (this.clients.length === 0) {
      throw new RedisConnectionError('Redis pool not initialized');
    }
    if (this.clients.length === 1) return this.clients[0];
    const c = this.clients[this.rrIndex];
    this.rrIndex = (this.rrIndex + 1) % this.clients.length;
    return c;
  }

  /**
   * True when at least one pool client reports connected. Health checks
   * succeed under partial pool failures, which is the right behaviour:
   * one degraded socket shouldn't take the whole engine offline.
   */
  private get isConnected(): boolean {
    return this.connectedFlags.some((f) => f);
  }

  constructor(
    private config: RedisConfig,
    circuitBreakerConfig: CircuitBreakerConfig,
    retryConfig: RetryConfig,
  ) {
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
    this.retryManager = new RetryManager(retryConfig);
    this.healthMetrics = new HealthMetrics();
    this.initializeConnection();
  }

  /**
   * Initialize the Redis pool. Creates `poolSize` independent clients
   * (defaulting to 1 for parity with the pre-pool implementation). Each
   * client gets:
   *   - the same connection options
   *   - all atomic Lua scripts pre-registered as named commands
   *   - the same lifecycle event handlers
   * Failures in any single client during init bubble up as connection
   * errors so the engine fails closed rather than silently degrading.
   */
  private initializeConnection(): void {
    try {
      const poolSize = Math.max(1, this.config.poolSize ?? 1);
      this.clients = [];
      this.connectedFlags = [];

      for (let i = 0; i < poolSize; i++) {
        const client = new Redis({
          host: this.config.host || 'localhost',
          port: this.config.port || 6379,
          password: this.config.password,
          db: this.config.db || 0,
          family: this.config.family || 4,
          // Distinct connection name per client makes pool members
          // identifiable in Redis CLIENT LIST.
          connectionName: this.config.connectionName
            ? `${this.config.connectionName}#${i}`
            : undefined,
          lazyConnect: false,
          maxRetriesPerRequest: this.config.maxRetriesPerRequest,
          enableReadyCheck: this.config.enableReadyCheck !== false,
          connectTimeout: this.config.connectTimeout || 10000,
          commandTimeout: this.config.commandTimeout || 5000,
          retryStrategy:
            this.config.retryStrategy ||
            ((times: number) => Math.min(times * 50, 2000)),
          keyPrefix: this.config.keyPrefix,
        });

        // Each client must have its own copy of the Lua scripts since
        // ioredis registers commands per-instance.
        for (const def of SCRIPT_DEFINITIONS) {
          client.defineCommand(def.name, {
            numberOfKeys: def.numberOfKeys,
            lua: def.script,
          });
        }

        this.clients.push(client);
        this.connectedFlags.push(false);
      }

      this.setupEventHandlers();
    } catch (error) {
      throw new RedisConnectionError(
        'Failed to initialize Redis connection',
        error as Error,
      );
    }
  }

  /**
   * Attach lifecycle handlers to every pool client. Per-client connect/
   * close events flip that client's slot in `connectedFlags` so the
   * aggregate `isConnected` getter reflects pool-wide state without
   * extra coordination.
   */
  private setupEventHandlers(): void {
    this.clients.forEach((client, idx) => {
      client.on('connect', () => {
        this.connectedFlags[idx] = true;
        this.healthMetrics.recordConnection();
      });
      client.on('ready', () => {
        this.connectedFlags[idx] = true;
        this.circuitBreaker.onSuccess();
      });
      client.on('error', (error: Error) => {
        this.healthMetrics.recordError();
        this.circuitBreaker.onFailure();

        console.error(
          `[RedisSchemaEngine] Redis client #${idx} error:`,
          error.message,
        );
      });
      client.on('close', () => {
        this.connectedFlags[idx] = false;
      });
      client.on('reconnecting', () => {
        // intentional no-op; reconnection handled by ioredis retryStrategy
      });
    });
  }

  /**
   * Manually connect every pool client. Used when `lazyConnect: true`
   * was passed via redis options; otherwise clients connect at
   * construction time. Errors from any single client bubble up.
   */
  public async connect(): Promise<void> {
    try {
      await Promise.all(
        this.clients.map(async (client, idx) => {
          await client.connect();
          this.connectedFlags[idx] = true;
        }),
      );
    } catch (error) {
      throw new RedisConnectionError(
        'Failed to connect to Redis',
        error as Error,
      );
    }
  }

  // =====================================================
  // CORE EXECUTION WRAPPER
  // =====================================================

  /**
   * Execute a Redis operation through circuit breaker + retry. All public
   * helpers below funnel through this. Latency is recorded for both success
   * and failure so health metrics reflect real traffic.
   */
  public async executeOperation<T>(
    operation: () => Promise<T>,
    operationName: string = 'redis_operation',
  ): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      return this.retryManager.executeWithRetry(async () => {
        const startTime = Date.now();
        try {
          const result = await operation();
          this.healthMetrics.recordSuccess(Date.now() - startTime);
          return result;
        } catch (error) {
          this.healthMetrics.recordFailure(Date.now() - startTime);
          throw new RedisConnectionError(
            `Redis operation '${operationName}' failed`,
            error as Error,
          );
        }
      });
    });
  }

  // =====================================================
  // TYPED COMMAND WRAPPERS (all routed through executeOperation)
  // =====================================================

  /**
   * GET wrapper. Records cache hit/miss for visibility into real traffic.
   */
  public async get(key: string): Promise<string | null> {
    return this.executeOperation(async () => {
      const value = await this.redis.get(key);
      if (value === null) {
        this.healthMetrics.recordMiss();
      } else {
        this.healthMetrics.recordHit();
      }
      return value;
    }, 'get');
  }

  /**
   * MGET wrapper. Records hit/miss per key for accurate hit-rate stats.
   */
  public async mget(keys: string[]): Promise<Array<string | null>> {
    if (keys.length === 0) return [];
    return this.executeOperation(async () => {
      const values = await this.redis.mget(...keys);
      for (const v of values) {
        if (v === null) this.healthMetrics.recordMiss();
        else this.healthMetrics.recordHit();
      }
      return values;
    }, 'mget');
  }

  /**
   * SET wrapper with optional TTL in seconds.
   */
  public async set(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    return this.executeOperation(async () => {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.redis.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.redis.set(key, value);
      }
    }, 'set');
  }

  /**
   * DEL wrapper. Returns the number of keys removed.
   */
  public async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.executeOperation(async () => {
      return this.redis.del(...keys);
    }, 'del');
  }

  /**
   * EXISTS wrapper. Returns the number of keys that exist (0 or 1 for single).
   */
  public async exists(key: string): Promise<number> {
    return this.executeOperation(async () => {
      return this.redis.exists(key);
    }, 'exists');
  }

  /**
   * Compare-and-set via Lua. Writes newValue only if current value at key
   * exactly equals expectedValue. Pass empty string to expect absence.
   * Returns true on success, false on conflict.
   */
  public async casSet(
    key: string,
    expectedValue: string,
    newValue: string,
    ttlSeconds: number = 0,
  ): Promise<boolean> {
    return this.executeOperation(async () => {
      const result = await this.scripted.rseCasSet(
        key,
        expectedValue,
        newValue,
        String(ttlSeconds),
      );
      return result === 1;
    }, 'casSet');
  }

  /**
   * Atomic set that only writes if the key already exists. Used for
   * "update only if cached" semantics. Returns true if applied.
   */
  public async setIfExists(
    key: string,
    value: string,
    ttlSeconds: number = 0,
  ): Promise<boolean> {
    return this.executeOperation(async () => {
      const result = await this.scripted.rseSetIfExists(
        key,
        value,
        String(ttlSeconds),
      );
      return result === 1;
    }, 'setIfExists');
  }

  /**
   * Atomic add to a JSON-array list at key. Idempotent; returns true if
   * the id was newly inserted, false if already present.
   */
  public async listAdd(
    listKey: string,
    id: string | number,
    ttlSeconds: number = 0,
  ): Promise<boolean> {
    return this.executeOperation(async () => {
      const numericFlag = typeof id === 'number' ? '1' : '0';
      const result = await this.scripted.rseListAdd(
        listKey,
        String(id),
        String(ttlSeconds),
        numericFlag,
      );
      return result === 1;
    }, 'listAdd');
  }

  /**
   * Atomic remove of an id from a JSON-array list. Preserves the existing
   * TTL on the key. Returns true if the id was found and removed.
   */
  public async listRemove(
    listKey: string,
    id: string | number,
  ): Promise<boolean> {
    return this.executeOperation(async () => {
      const result = await this.scripted.rseListRemove(listKey, String(id));
      return result === 1;
    }, 'listRemove');
  }

  // =====================================================
  // ZSET (indexed list) wrappers
  // =====================================================

  /**
   * Atomic ZADD with optional max-size trim and optional membership-index
   * update. Returns true when a brand-new member was added; false when an
   * existing member's score was updated (still considered "success").
   */
  public async zListAdd(
    listKey: string,
    membershipKey: string,
    score: number,
    id: string | number,
    ttlSeconds: number = 0,
    maxSize: number = 0,
    trackMembership: boolean = false,
  ): Promise<boolean> {
    return this.executeOperation(async () => {
      const result = await this.scripted.rseZListAdd(
        listKey,
        membershipKey,
        String(score),
        String(id),
        String(ttlSeconds),
        String(maxSize),
        trackMembership ? '1' : '0',
      );
      return result === 1;
    }, 'zListAdd');
  }

  /**
   * Atomic ZREM. Returns true if the id was a member of the set.
   */
  public async zListRemove(
    listKey: string,
    membershipKey: string,
    id: string | number,
    trackMembership: boolean = false,
  ): Promise<boolean> {
    return this.executeOperation(async () => {
      const result = await this.scripted.rseZListRemove(
        listKey,
        membershipKey,
        String(id),
        trackMembership ? '1' : '0',
      );
      return result === 1;
    }, 'zListRemove');
  }

  /**
   * Paginated read of a ZSET. Range semantics:
   *   - `reverse: false` (default) returns members in ascending score
   *     order (oldest first when score is timestamp).
   *   - `reverse: true` returns members in descending score order
   *     (newest first when score is timestamp) — the common feed case.
   *   - `offset` and `limit` are applied AFTER the score filter.
   *   - `minScore`/`maxScore` filter by score; defaults are -inf/+inf.
   *
   * Returns just the ids by default. Pass `withScores: true` to get the
   * raw `[id, score]` pairs for downstream filtering.
   */
  public async zListRange(
    listKey: string,
    opts: {
      offset?: number;
      limit?: number;
      reverse?: boolean;
      minScore?: number;
      maxScore?: number;
      withScores?: boolean;
    } = {},
  ): Promise<string[] | Array<{ id: string; score: number }>> {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const reverse = !!opts.reverse;
    const min = Number.isFinite(opts.minScore) ? String(opts.minScore) : '-inf';
    const max = Number.isFinite(opts.maxScore) ? String(opts.maxScore) : '+inf';

    return this.executeOperation(async () => {
      // Hits/misses recorded once per call for cardinality reasons. A
      // ZRANGEBYSCORE is one logical lookup; per-id miss tracking would
      // distort the metric.
      const args: (string | number)[] = reverse
        ? [listKey, max, min, 'LIMIT', offset, limit]
        : [listKey, min, max, 'LIMIT', offset, limit];

      let raw: string[];
      if (opts.withScores) {
        args.splice(3, 0, 'WITHSCORES');
      }
      if (reverse) {
        raw = await this.scripted.zrevrangebyscore(...args);
      } else {
        raw = await this.scripted.zrangebyscore(...args);
      }

      if (raw.length === 0) {
        this.healthMetrics.recordMiss();
      } else {
        this.healthMetrics.recordHit();
      }

      if (!opts.withScores) return raw;
      const pairs: Array<{ id: string; score: number }> = [];
      for (let i = 0; i < raw.length; i += 2) {
        pairs.push({ id: raw[i], score: Number(raw[i + 1]) });
      }
      return pairs;
    }, 'zListRange');
  }

  /**
   * Number of members currently in the ZSET. Returns 0 when the key is
   * absent (which Redis ZCARD reports natively).
   */
  public async zListSize(listKey: string): Promise<number> {
    return this.executeOperation(async () => {
      return (await this.redis.zcard(listKey)) ?? 0;
    }, 'zListSize');
  }

  /**
   * Cascade-invalidate an entity: ZREMs it from every tracked list and
   * deletes both the entity key and the membership back-index. Returns
   * the number of lists the entity was removed from. Safe to call when
   * the back-index does not exist (returns 0).
   */
  public async cascadeInvalidate(
    membershipKey: string,
    entityKey: string,
    id: string | number,
  ): Promise<number> {
    return this.executeOperation(async () => {
      const result = await this.scripted.rseCascadeInvalidate(
        membershipKey,
        entityKey,
        String(id),
      );
      return Number(result) || 0;
    }, 'cascadeInvalidate');
  }

  /**
   * Run an arbitrary pipeline. Internal use by the normalization engine for
   * bulk first-write operations. Errors inside the pipeline are surfaced.
   */
  public async runPipeline(
    build: (pipeline: ChainableCommander) => void,
  ): Promise<any[]> {
    return this.executeOperation(async () => {
      const pipeline = this.redis.pipeline();
      build(pipeline);
      const results = await pipeline.exec();
      if (!results) {
        throw new Error('Pipeline execution returned null');
      }
      const errors = results.filter(([err]) => err !== null);
      if (errors.length > 0) {
        throw new Error(
          `Pipeline errors: ${errors
            .map(([err]) => (err as Error)?.message ?? 'unknown')
            .join(', ')}`,
        );
      }
      return results.map(([, value]) => value);
    }, 'pipeline');
  }

  /**
   * Escape hatch returning one client from the pool. Prefer the typed
   * helpers above so traffic is observed and breaker-protected. This is
   * here for migrations and tests only and should not be used in hot
   * paths.
   */
  public getRawClient(): RedisInstance {
    return this.redis;
  }

  /**
   * Return all clients in the pool. Internal use for tests verifying
   * pool size and per-client state.
   */
  public getAllRawClients(): readonly RedisInstance[] {
    return this.clients;
  }

  // =====================================================
  // ADMIN / HEALTH
  // =====================================================

  /**
   * FLUSHDB wrapper. Caller is responsible for guarding this; the engine
   * adds an additional confirmation gate at the public API.
   */
  public async flushDb(): Promise<void> {
    return this.executeOperation(async () => {
      await this.redis.flushdb();
    }, 'flushdb');
  }

  /**
   * Delete every key that starts with the configured `keyPrefix`, using
   * non-blocking `SCAN` + `UNLINK` (async delete). This is the safe
   * equivalent of `FLUSHDB` for deployments that share a Redis DB with
   * other applications or environments: it only touches keys this engine
   * owns and never blocks the Redis server on large keyspaces.
   *
   * Implementation notes:
   *   - `SCAN` with `{ match: '*' }` works correctly because ioredis
   *     automatically prepends `keyPrefix` to the `MATCH` pattern on
   *     the wire, so Redis only returns keys under our namespace.
   *   - Redis returns the fully-prefixed keys. We strip the prefix
   *     before calling `UNLINK`, because ioredis re-applies the prefix
   *     on outbound commands — passing the raw prefixed keys would
   *     produce a double prefix and delete nothing.
   *   - Pinned to a single pool client (`clients[0]`) so the SCAN cursor
   *     is consistent; UNLINK batches can go through any client but
   *     using the same one keeps this simple and deterministic.
   *   - Returns the count of deleted keys for observability.
   *
   * Throws if `keyPrefix` is empty; caller should use `flushDb()` in
   * that case (FLUSHDB is still the right tool for a no-prefix setup).
   */
  public async clearPrefixedKeys(): Promise<number> {
    const prefix = this.config.keyPrefix;
    if (!prefix || prefix.length === 0) {
      throw new RedisConnectionError(
        'clearPrefixedKeys requires redis.keyPrefix to be set',
      );
    }

    return this.executeOperation(async () => {
      const client = this.clients[0];
      if (!client) {
        throw new RedisConnectionError('Redis pool not initialized');
      }

      let deleted = 0;
      // SCAN in batches of 500. Larger counts reduce round-trips but
      // increase per-call work on the Redis side; 500 is a safe middle
      // ground that performs well on keyspaces well past the 100k mark.
      const stream = client.scanStream({ match: '*', count: 500 });

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (keys: string[]) => {
          if (!keys || keys.length === 0) return;
          // Strip the prefix ioredis will re-apply in UNLINK. A key
          // that doesn't start with the prefix should not happen (SCAN
          // already filtered by prefix), but we skip it defensively
          // rather than delete something we don't own.
          const stripped: string[] = [];
          for (const k of keys) {
            if (k.startsWith(prefix)) {
              stripped.push(k.slice(prefix.length));
            }
          }
          if (stripped.length === 0) return;
          // Pause the stream while we UNLINK so we don't build up an
          // unbounded backlog of in-flight deletes on huge keyspaces.
          stream.pause();
          client
            .unlink(...stripped)
            .then((n) => {
              deleted += Number(n) || 0;
              stream.resume();
            })
            .catch((err) => {
              stream.destroy(err as Error);
            });
        });
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      return deleted;
    }, 'clearPrefixedKeys');
  }

  /**
   * The configured keyPrefix, or empty string if none. Consumers (e.g.
   * `clearAllCache`) branch on this to pick between scoped delete and
   * FLUSHDB.
   */
  public getKeyPrefix(): string {
    return this.config.keyPrefix ?? '';
  }

  public async isHealthy(): Promise<boolean> {
    try {
      await this.executeOperation(async () => {
        await this.redis.ping();
      }, 'ping');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read Redis used_memory in bytes via the INFO command. Returns 0 if the
   * value cannot be parsed (e.g. permission-restricted environments).
   */
  public async getRedisUsedMemory(): Promise<number> {
    try {
      const info = await this.executeOperation(
        async () => this.redis.info('memory'),
        'info_memory',
      );
      const match = /used_memory:(\d+)/.exec(info);
      return match ? Number(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  public getHealthMetrics(): {
    isConnected: boolean;
    circuitBreakerState: CircuitBreakerState;
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
    averageLatency: number;
    successRate: number;
    connections: number;
    errors: number;
    lastOperationTime: number;
    cacheHits: number;
    cacheMisses: number;
    hitRate: number;
  } {
    return {
      isConnected: this.isConnected,
      circuitBreakerState: this.circuitBreaker.getState(),
      ...this.healthMetrics.getMetrics(),
    };
  }

  /**
   * Cleanly close every pool client. Errors on individual clients are
   * logged but don't stop the others from quitting; the goal here is
   * resource cleanup, not strict success.
   */
  public async disconnect(): Promise<void> {
    await Promise.all(
      this.clients.map(async (client, idx) => {
        try {
          if (this.connectedFlags[idx]) {
            await client.quit();
          }
        } catch (error) {
          console.error(
            `[RedisSchemaEngine] Disconnect error on client #${idx}:`,
            error,
          );
        } finally {
          this.connectedFlags[idx] = false;
        }
      }),
    );
  }

  /**
   * Number of clients in the pool. Useful for tests and observability.
   */
  public getPoolSize(): number {
    return this.clients.length;
  }
}

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  private state: CircuitBreakerState;

  constructor(private config: CircuitBreakerConfig) {
    this.state = {
      state: 'CLOSED',
      failures: 0,
      lastFailureTime: 0,
      lastSuccessTime: Date.now(),
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.state.state = 'HALF_OPEN';
      } else {
        throw new CircuitBreakerOpenError();
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess(): void {
    this.state.failures = 0;
    this.state.state = 'CLOSED';
    this.state.lastSuccessTime = Date.now();
  }

  onFailure(): void {
    this.state.failures++;
    this.state.lastFailureTime = Date.now();

    if (this.state.failures >= this.config.threshold) {
      this.state.state = 'OPEN';
    }
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.state.lastFailureTime > this.config.resetTimeout;
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }
}

/**
 * Retry Manager implementation
 */
class RetryManager {
  constructor(private config: RetryConfig) {}

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {},
  ): Promise<T> {
    const {
      maxAttempts = this.config.maxAttempts,
      baseDelay = this.config.baseDelay,
      maxDelay = this.config.maxDelay,
      backoffFactor = this.config.backoffFactor,
    } = options;

    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxAttempts || !this.isRetryableError(error as Error)) {
          throw error;
        }

        const delay = Math.min(
          baseDelay * Math.pow(backoffFactor, attempt - 1),
          maxDelay,
        );

        await this.sleep(delay);
      }
    }

    throw lastError!;
  }

  private isRetryableError(error: Error): boolean {
    const retryableMessages = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNREFUSED',
      'Connection is closed',
    ];

    return retryableMessages.some(
      (msg) => error.message.includes(msg) || error.name.includes(msg),
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Health metrics tracker. Counts ops, latency, and cache hits/misses so the
 * engine can expose real (not stubbed) metrics. Lock-free; correct under
 * Node's single-threaded event loop.
 */
class HealthMetrics {
  private metrics = {
    totalOperations: 0,
    successfulOperations: 0,
    failedOperations: 0,
    totalLatency: 0,
    connections: 0,
    errors: 0,
    lastOperationTime: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  recordSuccess(latency: number): void {
    this.metrics.totalOperations++;
    this.metrics.successfulOperations++;
    this.metrics.totalLatency += latency;
    this.metrics.lastOperationTime = Date.now();
  }

  recordFailure(latency: number): void {
    this.metrics.totalOperations++;
    this.metrics.failedOperations++;
    this.metrics.totalLatency += latency;
    this.metrics.lastOperationTime = Date.now();
  }

  recordConnection(): void {
    this.metrics.connections++;
  }

  recordError(): void {
    this.metrics.errors++;
  }

  recordHit(): void {
    this.metrics.cacheHits++;
  }

  recordMiss(): void {
    this.metrics.cacheMisses++;
  }

  getMetrics() {
    const totalOps = this.metrics.totalOperations;
    const totalLookups = this.metrics.cacheHits + this.metrics.cacheMisses;
    const avgLatency = totalOps > 0 ? this.metrics.totalLatency / totalOps : 0;
    const successRate =
      totalOps > 0 ? this.metrics.successfulOperations / totalOps : 0;
    const hitRate =
      totalLookups > 0 ? this.metrics.cacheHits / totalLookups : 0;

    return {
      totalOperations: this.metrics.totalOperations,
      successfulOperations: this.metrics.successfulOperations,
      failedOperations: this.metrics.failedOperations,
      averageLatency: Math.round(avgLatency),
      successRate: Math.round(successRate * 100) / 100,
      connections: this.metrics.connections,
      errors: this.metrics.errors,
      lastOperationTime: this.metrics.lastOperationTime,
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      hitRate: Math.round(hitRate * 1000) / 1000,
    };
  }
}

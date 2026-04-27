/**
 * Configuration types for Redis Schema Engine
 */

import type { RedisOptions } from 'ioredis';
import type { Serializer } from '../core';

// Redis client interface to abstract away ioredis dependency
export interface RedisClient {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string): Promise<'OK'>;
  del(...keys: string[]): Promise<number>;
  ping(): Promise<'PONG'>;
  quit(): Promise<'OK'>;
  flushdb(): Promise<'OK'>;
  pipeline(): any; // Use any for now to avoid namespace issues
  on(event: string, listener: (...args: any[]) => void): void;
}

export interface RedisConnectionPoolConfig {
  min: number;
  max: number;
  acquireTimeoutMillis: number;
  idleTimeoutMillis: number;
}

export interface RedisConfig extends RedisOptions {
  keyPrefix?: string;
  connectionPool?: RedisConnectionPoolConfig;
  /**
   * Number of ioredis clients to open against the same Redis instance.
   * Each client is an independent TCP connection; commands are
   * round-robined across them. Increases throughput at high concurrency
   * by reducing head-of-line blocking on a single socket and using more
   * of Redis's parallelism. Default 1 preserves current behaviour.
   *
   * Recommended: 1 for dev / low traffic, 4-8 for typical production
   * workloads, 8-16 for sustained >10k ops/sec single-instance loads.
   * Going much higher rarely helps and consumes Redis connection slots.
   */
  poolSize?: number;
}

export interface PerformanceLimits {
  maxHydrationDepth: number;
  maxEntitiesPerRequest: number;
  maxMemoryUsagePerOperation: number;
  maxConcurrentOperations: number;
  batchSize: number;
}

export interface CircuitBreakerConfig {
  threshold: number;
  timeout: number;
  resetTimeout: number;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

export type FallbackStrategy = 'null' | 'empty' | 'cached' | 'custom';

export interface FallbackConfig {
  enabled: boolean;
  strategy: FallbackStrategy;
}

export interface ResilienceConfig {
  circuitBreaker: CircuitBreakerConfig;
  retry: RetryConfig;
  fallback: FallbackConfig;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface MonitoringConfig {
  enableMetrics: boolean;
  enableDebugMode: boolean;
  enableAuditLog: boolean;
  metricsInterval: number;
  logLevel: LogLevel;
}

export interface CacheConfig {
  defaultTTL: number;
  enableL1Cache: boolean;
  l1CacheSize: number;
  enableCompression: boolean;
  compressionThreshold: number;
  /**
   * (De)serializer used for entity payloads. Defaults to the engine's
   * lossless tagged JSON serializer, which preserves `Date`, `BigInt`,
   * `Map`, `Set`, `RegExp`, `Buffer`, `NaN`, and `±Infinity` across
   * cache round-trips while remaining backward-compatible with plain
   * JSON values written by older versions or other producers.
   *
   * Pass `JSON_SERIALIZER` to opt out (raw `JSON.stringify`/`parse`,
   * fastest but lossy for the types listed above), or supply any
   * `{ stringify, parse }` pair (e.g. wrapping `superjson`) to plug in
   * a third-party codec. The same instance is used for writes and
   * reads, so consistency is the consumer's responsibility when
   * swapping serializers against an existing cache.
   *
   * Note: list bodies (the JSON id-array stored under a `list`
   * schema's key) are intentionally NOT routed through this serializer
   * because Lua scripts on the Redis side parse them directly. Lists
   * always use plain JSON. Entity values (which contain user data)
   * are the only thing the serializer touches.
   */
  serializer?: Serializer;
}

/**
 * Safety guards for destructive operations. Kept in a dedicated config
 * block so the engine itself never has to read `process.env` at runtime
 * — important for npm-distributed builds where consumers' build systems
 * may not set NODE_ENV the way Node apps do.
 */
export interface SafetyConfig {
  /**
   * When true, `clearAllCache()` requires an additional
   * `{ allowProduction: true }` argument to succeed. Intended as a
   * safety net so a stray call from a test harness or a mis-targeted
   * CLI cannot wipe a production database.
   *
   * Defaults to `process.env.NODE_ENV === 'production'` at engine
   * construction time so existing consumers keep the same behaviour
   * with no config change. Library consumers should pass this
   * explicitly rather than relying on the env default.
   */
  productionMode: boolean;
}

export interface RedisSchemaEngineConfig {
  redis: RedisConfig;
  limits: PerformanceLimits;
  resilience: ResilienceConfig;
  monitoring: MonitoringConfig;
  cache: CacheConfig;
  safety: SafetyConfig;
}

export type PartialRedisSchemaEngineConfig =
  Partial<RedisSchemaEngineConfig> & {
    redis?: Partial<RedisConfig>;
    limits?: Partial<PerformanceLimits>;
    resilience?: Partial<ResilienceConfig>;
    monitoring?: Partial<MonitoringConfig>;
    cache?: Partial<CacheConfig>;
    safety?: Partial<SafetyConfig>;
  };

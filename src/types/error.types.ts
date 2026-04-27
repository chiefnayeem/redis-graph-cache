/**
 * Error types and classification for Redis Schema Engine
 */

export enum RedisSchemaEngineErrorType {
  SCHEMA_VALIDATION = 'SCHEMA_VALIDATION',
  ENTITY_NOT_FOUND = 'ENTITY_NOT_FOUND',
  INVALID_OPERATION = 'INVALID_OPERATION',
  REDIS_CONNECTION = 'REDIS_CONNECTION',
  MEMORY_LIMIT = 'MEMORY_LIMIT',
  TIMEOUT = 'TIMEOUT',
  CONCURRENT_MODIFICATION = 'CONCURRENT_MODIFICATION',
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
  HYDRATION_DEPTH_EXCEEDED = 'HYDRATION_DEPTH_EXCEEDED',
  INVALID_SCHEMA = 'INVALID_SCHEMA',
  MISSING_RELATION = 'MISSING_RELATION',
}

export class RedisSchemaEngineError extends Error {
  public readonly type: RedisSchemaEngineErrorType;
  public readonly context?: any;
  public readonly cause?: Error;
  public readonly timestamp: number;
  public readonly requestId?: string;

  constructor(
    type: RedisSchemaEngineErrorType,
    message: string,
    context?: any,
    cause?: Error,
    requestId?: string,
  ) {
    super(message);
    this.name = 'RedisSchemaEngineError';
    this.type = type;
    this.context = context;
    this.cause = cause;
    this.timestamp = Date.now();
    this.requestId = requestId;

    // Maintain proper stack trace (Node.js / V8 specific). On
    // non-V8 runtimes `captureStackTrace` is undefined and the
    // optional chain short-circuits cleanly.
    Error.captureStackTrace?.(this, RedisSchemaEngineError);
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
      requestId: this.requestId,
      stack: this.stack,
    };
  }
}

export class SchemaValidationError extends RedisSchemaEngineError {
  constructor(message: string, context?: any, requestId?: string) {
    super(
      RedisSchemaEngineErrorType.SCHEMA_VALIDATION,
      message,
      context,
      undefined,
      requestId,
    );
  }
}

export class EntityNotFoundError extends RedisSchemaEngineError {
  constructor(entityType: string, id: string | number, requestId?: string) {
    super(
      RedisSchemaEngineErrorType.ENTITY_NOT_FOUND,
      `Entity '${entityType}' with id '${id}' not found`,
      { entityType, id },
      undefined,
      requestId,
    );
  }
}

export class InvalidOperationError extends RedisSchemaEngineError {
  constructor(
    operation: string,
    reason: string,
    context?: any,
    requestId?: string,
  ) {
    super(
      RedisSchemaEngineErrorType.INVALID_OPERATION,
      `Invalid operation '${operation}': ${reason}`,
      { operation, reason, ...context },
      undefined,
      requestId,
    );
  }
}

export class RedisConnectionError extends RedisSchemaEngineError {
  constructor(message: string, cause?: Error, requestId?: string) {
    super(
      RedisSchemaEngineErrorType.REDIS_CONNECTION,
      `Redis connection error: ${message}`,
      undefined,
      cause,
      requestId,
    );
  }
}

export class MemoryLimitError extends RedisSchemaEngineError {
  constructor(currentUsage: number, limit: number, requestId?: string) {
    super(
      RedisSchemaEngineErrorType.MEMORY_LIMIT,
      `Memory limit exceeded: ${currentUsage}MB > ${limit}MB`,
      { currentUsage, limit },
      undefined,
      requestId,
    );
  }
}

export class CircuitBreakerOpenError extends RedisSchemaEngineError {
  constructor(requestId?: string) {
    super(
      RedisSchemaEngineErrorType.CIRCUIT_BREAKER_OPEN,
      'Circuit breaker is OPEN - Redis operations are temporarily disabled',
      undefined,
      undefined,
      requestId,
    );
  }
}

export class HydrationDepthExceededError extends RedisSchemaEngineError {
  constructor(currentDepth: number, maxDepth: number, requestId?: string) {
    super(
      RedisSchemaEngineErrorType.HYDRATION_DEPTH_EXCEEDED,
      `Hydration depth exceeded: ${currentDepth} > ${maxDepth}`,
      { currentDepth, maxDepth },
      undefined,
      requestId,
    );
  }
}

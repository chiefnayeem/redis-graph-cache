/**
 * redis-graph-cache
 *
 * A TypeScript-first Redis data layer with schema-driven normalization,
 * relationship management, and graph-based hydration for high-performance
 * Node.js applications handling millions of entities with complex
 * relationships.
 */

// Main engine class (the primary export — what 95% of consumers need)
export { RedisGraphCache } from './redis-graph-cache';

// Core components, utilities, and serializers
export * from './core';

// All public types (schemas, configs, operations, errors, utilities)
export * from './types';

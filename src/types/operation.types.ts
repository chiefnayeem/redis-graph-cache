/**
 * Operation result and context types for Redis Schema Engine
 */

export interface WriteResult {
  success: boolean;
  keys: string[];
  operationId: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface ListWriteResult {
  success: boolean;
  key: string;
  ids: any[];
  operationId: string;
  timestamp: number;
}

export interface BulkWriteOperation {
  entityType: string;
  id: string | number;
  data: any;
}

export interface BulkDeleteOperation {
  entityType: string;
  id: string | number;
}

export interface BulkWriteResult {
  success: boolean;
  totalOperations: number;
  successfulOperations: number;
  failedOperations: BulkOperationFailure[];
  operationId: string;
  timestamp: number;
}

export interface BulkDeleteResult {
  success: boolean;
  totalOperations: number;
  successfulOperations: number;
  failedOperations: BulkOperationFailure[];
  operationId: string;
  timestamp: number;
}

export interface BulkOperationFailure {
  operation: BulkWriteOperation | BulkDeleteOperation;
  error: string;
  index: number;
}

export interface CacheMetrics {
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  totalOperations: number;
  avgResponseTime: number;
  memoryUsage: number;
  activeConnections: number;
  failedOperations: number;
  lastUpdated: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  redis: {
    connected: boolean;
    latency: number;
    memoryUsage: number;
  };
  engine: {
    activeOperations: number;
    memoryUsage: number;
    errorRate: number;
  };
  timestamp: number;
}

export interface HydrationOptions {
  maxDepth?: number;
  selectiveFields?: string[];
  excludeRelations?: string[];
  memoryLimit?: number;
}

export interface WriteContext {
  entityType: string;
  id: string | number;
  data: any;
  options?: any;
  requestId: string;
  timestamp: number;
}

export interface ReadContext {
  entityType: string;
  id: string | number;
  options?: HydrationOptions;
  requestId: string;
  timestamp: number;
}

export interface OperationContext {
  operation: string;
  entityType?: string;
  id?: string | number;
  requestId: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

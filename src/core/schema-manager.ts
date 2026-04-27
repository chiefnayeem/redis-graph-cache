/**
 * Schema Manager - Validates and manages entity and list schemas
 */

import {
  Schema,
  SchemaDefinition,
  EntitySchema,
  ListSchema,
  IndexedListSchema,
  SchemaValidationResult,
  RelationDefinition,
  SchemaValidationError,
  InvalidOperationError,
} from '../types';

export class SchemaManager {
  private schemas: Map<string, SchemaDefinition> = new Map();
  private entitySchemas: Map<string, EntitySchema> = new Map();
  private listSchemas: Map<string, ListSchema> = new Map();
  private indexedListSchemas: Map<string, IndexedListSchema> = new Map();
  private validationCache: Map<string, SchemaValidationResult> = new Map();
  private defaultTTL: number;

  constructor(schema: Schema, defaultTTL: number = 0) {
    this.defaultTTL = defaultTTL;
    this.registerSchema(schema);
  }

  /**
   * Resolve the TTL (seconds) to apply when writing an entity. Schema-level
   * `ttl` wins; otherwise falls back to the engine-wide defaultTTL. Returns
   * 0 when no TTL should be applied (key persists indefinitely).
   */
  public resolveEntityTTL(entityType: string): number {
    const schema = this.entitySchemas.get(entityType);
    if (schema?.ttl !== undefined) return schema.ttl;
    return this.defaultTTL;
  }

  /**
   * Resolve the TTL (seconds) for list keys. Schema-level `ttl` on the list
   * wins; otherwise falls back to engine defaultTTL.
   */
  public resolveListTTL(listType: string): number {
    const schema = this.listSchemas.get(listType);
    if (schema?.ttl !== undefined) return schema.ttl;
    return this.defaultTTL;
  }

  /**
   * Resolve TTL for an indexed-list ZSET key.
   */
  public resolveIndexedListTTL(listType: string): number {
    const schema = this.indexedListSchemas.get(listType);
    if (schema?.ttl !== undefined) return schema.ttl;
    return this.defaultTTL;
  }

  /**
   * Internal namespace prefix used for membership back-index keys. Kept
   * isolated so user schemas cannot accidentally collide with it.
   */
  public static readonly MEMBERSHIP_PREFIX = '__rse_membership';

  /**
   * Build the back-index key tracking which list keys currently contain a
   * given entity. Used by indexed lists with `trackMembership: true` so
   * cascade invalidation can find and remove the entity from every list.
   */
  public generateMembershipKey(
    entityType: string,
    id: string | number,
  ): string {
    return `${SchemaManager.MEMBERSHIP_PREFIX}:${entityType}:${id}`;
  }

  /**
   * Register and validate a complete schema
   */
  public registerSchema(schema: Schema): void {
    // Clear existing schemas
    this.schemas.clear();
    this.entitySchemas.clear();
    this.listSchemas.clear();
    this.indexedListSchemas.clear();
    this.validationCache.clear();

    // First pass: register all schemas keyed by name and bucket by kind so
    // later validation passes can reference siblings by name.
    for (const [name, definition] of Object.entries(schema)) {
      this.schemas.set(name, definition);

      if (definition.type === 'entity') {
        this.entitySchemas.set(name, definition);
      } else if (definition.type === 'list') {
        this.listSchemas.set(name, definition);
      } else if (definition.type === 'indexedList') {
        this.indexedListSchemas.set(name, definition);
      }
    }

    // Second pass: Validate all schemas
    const validationResult = this.validateCompleteSchema();
    if (!validationResult.isValid) {
      throw new SchemaValidationError(
        `Schema validation failed: ${validationResult.errors.join(', ')}`,
        {
          errors: validationResult.errors,
          warnings: validationResult.warnings,
        },
      );
    }
  }

  /**
   * Get entity schema by name
   */
  public getEntitySchema(entityType: string): EntitySchema {
    const schema = this.entitySchemas.get(entityType);
    if (!schema) {
      throw new InvalidOperationError(
        'getEntitySchema',
        `Entity schema '${entityType}' not found`,
        { entityType, availableSchemas: Array.from(this.entitySchemas.keys()) },
      );
    }
    return schema;
  }

  /**
   * Get list schema by name
   */
  public getListSchema(listType: string): ListSchema {
    const schema = this.listSchemas.get(listType);
    if (!schema) {
      throw new InvalidOperationError(
        'getListSchema',
        `List schema '${listType}' not found`,
        { listType, availableSchemas: Array.from(this.listSchemas.keys()) },
      );
    }
    return schema;
  }

  /**
   * Get indexed-list schema by name. Throws if not registered or not the
   * indexed kind, so callers can rely on the returned schema's structure.
   */
  public getIndexedListSchema(listType: string): IndexedListSchema {
    const schema = this.indexedListSchemas.get(listType);
    if (!schema) {
      throw new InvalidOperationError(
        'getIndexedListSchema',
        `Indexed list schema '${listType}' not found`,
        {
          listType,
          availableSchemas: Array.from(this.indexedListSchemas.keys()),
        },
      );
    }
    return schema;
  }

  public hasIndexedListSchema(listType: string): boolean {
    return this.indexedListSchemas.has(listType);
  }

  public getIndexedListSchemaNames(): string[] {
    return Array.from(this.indexedListSchemas.keys());
  }

  /**
   * Generate Redis key for an indexed list, using its schema-supplied key
   * function. Same pattern as `generateListKey` for plain lists.
   */
  public generateIndexedListKey(listType: string, ...params: any[]): string {
    const schema = this.getIndexedListSchema(listType);
    return schema.key(...params);
  }

  /**
   * Check if entity schema exists
   */
  public hasEntitySchema(entityType: string): boolean {
    return this.entitySchemas.has(entityType);
  }

  /**
   * Check if list schema exists
   */
  public hasListSchema(listType: string): boolean {
    return this.listSchemas.has(listType);
  }

  /**
   * Get all entity schema names
   */
  public getEntitySchemaNames(): string[] {
    return Array.from(this.entitySchemas.keys());
  }

  /**
   * Get all list schema names
   */
  public getListSchemaNames(): string[] {
    return Array.from(this.listSchemas.keys());
  }

  /**
   * Validate complete schema for consistency and relationships
   */
  private validateCompleteSchema(): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate each entity schema
    for (const name of Array.from(this.entitySchemas.keys())) {
      const schema = this.entitySchemas.get(name)!;
      const result = this.validateEntitySchema(name, schema);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    // Validate each list schema
    for (const name of Array.from(this.listSchemas.keys())) {
      const schema = this.listSchemas.get(name)!;
      const result = this.validateListSchema(name, schema);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    // Validate each indexed-list schema. Same baseline rules as list, plus
    // ZSET-specific checks (scoreField name, maxSize positivity).
    for (const name of Array.from(this.indexedListSchemas.keys())) {
      const schema = this.indexedListSchemas.get(name)!;
      const result = this.validateIndexedListSchema(name, schema);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    // Check for circular dependencies
    const circularDeps = this.detectCircularDependencies();
    if (circularDeps.length > 0) {
      warnings.push(
        `Circular dependencies detected: ${circularDeps.join(', ')}`,
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate individual entity schema
   */
  private validateEntitySchema(
    name: string,
    schema: EntitySchema,
  ): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!schema.id || typeof schema.id !== 'string') {
      errors.push(`Entity '${name}': id field must be a non-empty string`);
    }

    if (!schema.key || typeof schema.key !== 'function') {
      errors.push(`Entity '${name}': key must be a function`);
    }

    // Validate field definitions
    if (schema.fields) {
      for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
        if (
          !fieldDef.type ||
          ![
            'string',
            'number',
            'boolean',
            'object',
            'array',
            // Extended types preserved losslessly by the default
            // tagged serializer. Listed here purely for schema
            // validation; the engine still does not coerce values
            // based on the declared type.
            'date',
            'bigint',
            'map',
            'set',
            'regexp',
            'buffer',
          ].includes(fieldDef.type)
        ) {
          errors.push(
            `Entity '${name}', field '${fieldName}': invalid field type '${fieldDef.type}'`,
          );
        }

        // Check for internal field prefix conflicts
        if (fieldName.startsWith('__rse_')) {
          errors.push(
            `Entity '${name}', field '${fieldName}': field names cannot start with '__rse_' (reserved for internal use)`,
          );
        }
      }
    }

    // Validate relationship definitions
    if (schema.relations) {
      for (const [relationName, relationDef] of Object.entries(
        schema.relations,
      )) {
        const relationErrors = this.validateRelationDefinition(
          name,
          relationName,
          relationDef,
        );
        errors.push(...relationErrors);

        // Check for internal field prefix conflicts
        if (relationName.startsWith('__rse_')) {
          errors.push(
            `Entity '${name}', relation '${relationName}': relation names cannot start with '__rse_' (reserved for internal use)`,
          );
        }
      }
    }

    // Validate TTL
    if (
      schema.ttl !== undefined &&
      (typeof schema.ttl !== 'number' || schema.ttl < 0)
    ) {
      errors.push(`Entity '${name}': ttl must be a positive number`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate individual list schema
   */
  private validateListSchema(
    name: string,
    schema: ListSchema,
  ): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!schema.entityType || typeof schema.entityType !== 'string') {
      errors.push(`List '${name}': entityType must be a non-empty string`);
    } else if (!this.hasEntitySchema(schema.entityType)) {
      errors.push(
        `List '${name}': referenced entity type '${schema.entityType}' does not exist`,
      );
    }

    if (!schema.key || typeof schema.key !== 'function') {
      errors.push(`List '${name}': key must be a function`);
    }

    if (!schema.idField || typeof schema.idField !== 'string') {
      errors.push(`List '${name}': idField must be a non-empty string`);
    }

    // Validate TTL
    if (
      schema.ttl !== undefined &&
      (typeof schema.ttl !== 'number' || schema.ttl < 0)
    ) {
      errors.push(`List '${name}': ttl must be a positive number`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate an indexed list schema. Mirrors validateListSchema and adds
   * the ZSET-specific checks. The score field, when given, isn't bound to
   * any field type because we only call `Number(...)` on it at insert time.
   */
  private validateIndexedListSchema(
    name: string,
    schema: IndexedListSchema,
  ): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!schema.entityType || typeof schema.entityType !== 'string') {
      errors.push(
        `Indexed list '${name}': entityType must be a non-empty string`,
      );
    } else if (!this.hasEntitySchema(schema.entityType)) {
      errors.push(
        `Indexed list '${name}': referenced entity type '${schema.entityType}' does not exist`,
      );
    }

    if (!schema.key || typeof schema.key !== 'function') {
      errors.push(`Indexed list '${name}': key must be a function`);
    }

    if (!schema.idField || typeof schema.idField !== 'string') {
      errors.push(`Indexed list '${name}': idField must be a non-empty string`);
    }

    if (
      schema.scoreField !== undefined &&
      (typeof schema.scoreField !== 'string' || schema.scoreField.length === 0)
    ) {
      errors.push(
        `Indexed list '${name}': scoreField must be a non-empty string when provided`,
      );
    }

    if (
      schema.maxSize !== undefined &&
      (!Number.isFinite(schema.maxSize) || schema.maxSize <= 0)
    ) {
      errors.push(`Indexed list '${name}': maxSize must be a positive number`);
    }

    if (
      schema.ttl !== undefined &&
      (typeof schema.ttl !== 'number' || schema.ttl < 0)
    ) {
      errors.push(`Indexed list '${name}': ttl must be a positive number`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate relationship definition
   */
  private validateRelationDefinition(
    entityName: string,
    relationName: string,
    relation: RelationDefinition,
  ): string[] {
    const errors: string[] = [];

    // Validate relation type exists
    if (!relation.type || typeof relation.type !== 'string') {
      errors.push(
        `Entity '${entityName}', relation '${relationName}': type must be a non-empty string`,
      );
    } else if (!this.hasEntitySchema(relation.type)) {
      errors.push(
        `Entity '${entityName}', relation '${relationName}': referenced entity type '${relation.type}' does not exist`,
      );
    }

    // Validate relation kind
    if (!relation.kind || !['one', 'many'].includes(relation.kind)) {
      errors.push(
        `Entity '${entityName}', relation '${relationName}': kind must be 'one' or 'many'`,
      );
    }

    return errors;
  }

  /**
   * Detect circular dependencies in relationships
   */
  private detectCircularDependencies(): string[] {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[] = [];

    const dfs = (entityType: string, path: string[]): void => {
      if (recursionStack.has(entityType)) {
        const cycleStart = path.indexOf(entityType);
        const cycle = path.slice(cycleStart).concat(entityType);
        cycles.push(cycle.join(' -> '));
        return;
      }

      if (visited.has(entityType)) {
        return;
      }

      visited.add(entityType);
      recursionStack.add(entityType);

      const schema = this.entitySchemas.get(entityType);
      if (schema?.relations) {
        for (const relation of Object.values(schema.relations)) {
          if (this.hasEntitySchema(relation.type)) {
            dfs(relation.type, [...path, entityType]);
          }
        }
      }

      recursionStack.delete(entityType);
    };

    for (const entityType of Array.from(this.entitySchemas.keys())) {
      if (!visited.has(entityType)) {
        dfs(entityType, []);
      }
    }

    return cycles;
  }

  /**
   * Generate Redis key for entity
   */
  public generateEntityKey(entityType: string, id: string | number): string {
    const schema = this.getEntitySchema(entityType);
    return schema.key(id);
  }

  /**
   * Generate Redis key for list
   */
  public generateListKey(listType: string, ...params: any[]): string {
    const schema = this.getListSchema(listType);
    return schema.key(...params);
  }

  /**
   * Get entity ID field name
   */
  public getEntityIdField(entityType: string): string {
    const schema = this.getEntitySchema(entityType);
    return schema.id;
  }

  /**
   * Get list ID field name
   */
  public getListIdField(listType: string): string {
    const schema = this.getListSchema(listType);
    return schema.idField;
  }

  /**
   * Check if field is defined in entity schema
   */
  public hasEntityField(entityType: string, fieldName: string): boolean {
    const schema = this.getEntitySchema(entityType);
    return schema.fields ? fieldName in schema.fields : false;
  }

  /**
   * Check if relation is defined in entity schema
   */
  public hasEntityRelation(entityType: string, relationName: string): boolean {
    const schema = this.getEntitySchema(entityType);
    return schema.relations ? relationName in schema.relations : false;
  }

  /**
   * Get entity relation definition
   */
  public getEntityRelation(
    entityType: string,
    relationName: string,
  ): RelationDefinition {
    const schema = this.getEntitySchema(entityType);
    if (!schema.relations || !(relationName in schema.relations)) {
      throw new InvalidOperationError(
        'getEntityRelation',
        `Relation '${relationName}' not found in entity '${entityType}'`,
        { entityType, relationName },
      );
    }
    return schema.relations[relationName];
  }
}

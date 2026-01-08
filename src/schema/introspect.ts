/**
 * Schema introspection utilities
 *
 * Provides functionality to introspect ZenStack schemas and databases,
 * extracting model and field information for code generation.
 */

import * as fs from "fs/promises";
import * as path from "path";

export interface FieldInfo {
  /** Field name */
  name: string;
  /** Field type (String, Int, Boolean, etc.) */
  type: string;
  /** Whether the field is optional */
  isOptional: boolean;
  /** Whether the field is an array */
  isArray: boolean;
  /** Whether this is a relation field */
  isRelation: boolean;
  /** Whether this is the primary key */
  isId: boolean;
  /** Whether the field has a default value */
  hasDefault: boolean;
  /** Whether the field is unique */
  isUnique: boolean;
  /** Related model name (for relations) */
  relationModel?: string;
}

export interface ModelInfo {
  /** Model name */
  name: string;
  /** Table name in database */
  tableName: string;
  /** Model fields */
  fields: FieldInfo[];
}

export interface SchemaInfo {
  /** All models in the schema */
  models: ModelInfo[];
  /** Schema version or hash */
  version: string;
}

interface IntrospectOptions {
  /** Path to ZenStack schema file */
  schemaPath?: string;
  /** Database connection URL (for database introspection) */
  databaseUrl?: string;
  /** Output path for generated schema */
  outputPath?: string;
}

/**
 * Parse a .zmodel file and extract schema information
 * This is a simplified parser - in production, you'd use ZenStack's AST
 */
async function parseZModelFile(schemaPath: string): Promise<SchemaInfo> {
  const content = await fs.readFile(schemaPath, "utf-8");
  const models: ModelInfo[] = [];

  // Simple regex-based parser for demonstration
  // In production, integrate with ZenStack's parser
  const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
  const fieldRegex = /^\s*(\w+)\s+(\w+)(\[\])?\s*(\?)?\s*(.*?)$/gm;

  let modelMatch;
  while ((modelMatch = modelRegex.exec(content)) !== null) {
    const modelName = modelMatch[1];
    const modelBody = modelMatch[2];
    const fields: FieldInfo[] = [];

    let fieldMatch;
    const fieldPattern = /^\s*(\w+)\s+(\w+)(\[\])?\s*(\?)?(.*)$/gm;
    while ((fieldMatch = fieldPattern.exec(modelBody)) !== null) {
      const [, name, type, isArray, isOptional, modifiers] = fieldMatch;

      // Skip if it looks like a directive
      if (name.startsWith("@@") || name.startsWith("//")) continue;

      const isId = modifiers?.includes("@id") || false;
      const hasDefault = modifiers?.includes("@default") || false;
      const isUnique = modifiers?.includes("@unique") || isId;
      const isRelation = modifiers?.includes("@relation") || false;

      fields.push({
        name,
        type,
        isOptional: !!isOptional,
        isArray: !!isArray,
        isRelation,
        isId,
        hasDefault,
        isUnique,
        relationModel: isRelation ? type : undefined,
      });
    }

    models.push({
      name: modelName,
      tableName: modelName.toLowerCase(),
      fields,
    });
  }

  // Generate a simple version hash
  const version = Buffer.from(content).toString("base64").slice(0, 8);

  return { models, version };
}

/**
 * Introspect a database and generate schema information
 */
async function introspectDatabase(databaseUrl: string): Promise<SchemaInfo> {
  void databaseUrl;
  throw new Error("Database introspection is not supported.");
}

/**
 * Introspect schema from file or database
 */
export async function introspectSchema(options: IntrospectOptions): Promise<SchemaInfo> {
  if (options.schemaPath) {
    return parseZModelFile(options.schemaPath);
  }

  if (options.databaseUrl) {
    return introspectDatabase(options.databaseUrl);
  }

  throw new Error("Either schemaPath or databaseUrl must be provided");
}

/**
 * zenstack-kit - Drizzle-kit like CLI tooling for ZenStack schemas with Kysely support
 *
 * This package provides database migration and introspection utilities for ZenStack V3
 * schemas, generating Kysely-compatible type definitions and migration files.
 *
 * @packageDocumentation
 */

// Core functionality
export { introspectSchema, type SchemaInfo, type ModelInfo, type FieldInfo } from "./introspect.js";
export {
  createMigration,
  getSchemaDiff,
  hasSchemaChanges,
  type MigrationOptions,
  type Migration,
} from "./migrations.js";
export { applyMigrations, type ApplyMigrationsOptions } from "./migrate-apply.js";
export { setPromptProvider, type PromptProvider } from "./prompts.js";

// CLI utilities
export { defineConfig, type ZenStackKitConfig } from "./config.js";

// Kysely integration
export {
  createKyselyAdapter,
  type KyselyAdapter,
  type KyselyDialect,
} from "./kysely-adapter.js";

// Database pull (introspection)
export { pullSchema, type PullOptions, type PullResult } from "./pull.js";

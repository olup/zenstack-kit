/**
 * zenstack-kit - Drizzle-kit like CLI tooling for ZenStack schemas with Kysely support
 *
 * This package provides database migration and introspection utilities for ZenStack V3
 * schemas, generating Kysely-compatible type definitions and migration files.
 *
 * @packageDocumentation
 */

// Core functionality
export { introspectSchema, type SchemaInfo, type ModelInfo, type FieldInfo } from "./schema/introspect.js";
export {
  createMigration,
  getSchemaDiff,
  hasSchemaChanges,
  initSnapshot,
  type MigrationOptions,
  type Migration,
  type InitSnapshotOptions,
  type InitSnapshotResult,
} from "./migrations/diff.js";
export { applyMigrations, type ApplyMigrationsOptions } from "./migrations/apply.js";
export { setPromptProvider, type PromptProvider } from "./cli/prompt-provider.js";

// Prisma-compatible migrations (default)
export {
  createPrismaMigration,
  createEmptyMigration,
  applyPrismaMigrations,
  previewPrismaMigrations,
  hasPrismaSchemaChanges,
  createInitialMigration,
  initializeSnapshot,
  hasSnapshot,
  scanMigrationFolders,
  readMigrationLog,
  writeMigrationLog,
  appendToMigrationLog,
  getMigrationLogPath,
  calculateChecksum,
  detectPotentialRenames,
  type PrismaMigrationOptions,
  type PrismaMigration,
  type CreateEmptyMigrationOptions,
  type ApplyPrismaMigrationsOptions,
  type ApplyPrismaMigrationsResult,
  type PreviewPrismaMigrationsResult,
  type CreateInitialMigrationOptions,
  type MigrationLogEntry,
  type PotentialTableRename,
  type PotentialColumnRename,
  type PotentialRenames,
} from "./migrations/prisma.js";

// High-level programmatic API
export { migrate, type MigrateOptions, type MigrateResult } from "./migrate.js";

// CLI utilities
export { defineConfig, type ZenStackKitConfig } from "./config/index.js";
export { type RenameChoice } from "./cli/prompts.js";

// Kysely integration
export {
  createKyselyAdapter,
  type KyselyAdapter,
  type KyselyDialect,
} from "./sql/kysely-adapter.js";

// Database pull (introspection)
export { pullSchema, type PullOptions, type PullResult } from "./schema/pull.js";

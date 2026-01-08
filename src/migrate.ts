/**
 * High-level programmatic API for zenstack-kit migrations
 *
 * This module provides a simple interface for applying migrations from code,
 * useful for running migrations during application startup or in CI/CD pipelines.
 *
 * @example
 * ```typescript
 * import { migrate } from "zenstack-kit";
 *
 * // Apply migrations using config file
 * await migrate();
 *
 * // Apply migrations with explicit options
 * await migrate({
 *   migrationsFolder: "./prisma/migrations",
 *   dialect: "postgres",
 *   connectionUrl: process.env.DATABASE_URL,
 * });
 *
 * // Preview migrations without applying
 * const result = await migrate({ preview: true });
 * console.log("Pending migrations:", result.pending);
 * ```
 */

import { loadConfig } from "./config/loader.js";
import {
  applyPrismaMigrations,
  previewPrismaMigrations,
  type ApplyPrismaMigrationsResult,
  type PreviewPrismaMigrationsResult,
} from "./migrations/prisma.js";
import type { KyselyDialect } from "./sql/kysely-adapter.js";
import * as path from "path";

export interface MigrateOptions {
  /**
   * Path to migrations folder.
   * If not provided, will be read from config file.
   */
  migrationsFolder?: string;

  /**
   * Database dialect: "sqlite", "postgres", or "mysql"
   * If not provided, will be read from config file.
   */
  dialect?: KyselyDialect;

  /**
   * Database connection URL (for postgres/mysql).
   * If not provided, will be read from config file.
   */
  connectionUrl?: string;

  /**
   * SQLite database file path.
   * If not provided, will be read from config file.
   */
  databasePath?: string;

  /**
   * Migrations table name.
   * @default "_prisma_migrations"
   */
  migrationsTable?: string;

  /**
   * Migrations schema (PostgreSQL only).
   * @default "public"
   */
  migrationsSchema?: string;

  /**
   * If true, preview pending migrations without applying them.
   * @default false
   */
  preview?: boolean;

  /**
   * Current working directory for config resolution.
   * @default process.cwd()
   */
  cwd?: string;
}

export type MigrateResult =
  | (ApplyPrismaMigrationsResult & { mode: "apply" })
  | (PreviewPrismaMigrationsResult & { mode: "preview" });

/**
 * Apply or preview database migrations programmatically.
 *
 * This function can be used in application code to run migrations during startup,
 * or in scripts and CI/CD pipelines.
 *
 * @param options - Migration options. If not provided, reads from config file.
 * @returns Result of migration apply or preview operation.
 * @throws Error if migrations fail or required configuration is missing.
 *
 * @example
 * ```typescript
 * // Run migrations on app startup
 * import { migrate } from "zenstack-kit";
 *
 * async function main() {
 *   const result = await migrate();
 *   console.log(`Applied ${result.applied.length} migrations`);
 *
 *   // Start your app...
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Preview in development
 * const preview = await migrate({ preview: true });
 * if (preview.pending.length > 0) {
 *   console.log("Pending migrations:", preview.pending.map(m => m.name));
 * }
 * ```
 */
export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const cwd = options.cwd ?? process.cwd();

  // Load config if options not fully provided
  let migrationsFolder = options.migrationsFolder;
  let dialect = options.dialect;
  let connectionUrl = options.connectionUrl;
  let databasePath = options.databasePath;

  if (!migrationsFolder || !dialect) {
    const loaded = await loadConfig(cwd);

    if (loaded) {
      const { config, configDir } = loaded;

      if (!migrationsFolder) {
        const relativeFolder = config.migrations?.migrationsFolder ?? "./prisma/migrations";
        migrationsFolder = path.resolve(configDir, relativeFolder);
      }

      if (!dialect) {
        dialect = (config.dialect ?? "sqlite") as KyselyDialect;
      }

      if (!connectionUrl && !databasePath) {
        const dbCredentials = config.dbCredentials as Record<string, unknown> | undefined;
        if (dialect === "sqlite") {
          databasePath = dbCredentials?.file as string | undefined;
        } else {
          connectionUrl = dbCredentials?.url as string | undefined;
        }
      }
    }
  }

  // Validate required options
  if (!migrationsFolder) {
    throw new Error(
      "migrationsFolder is required. Provide it in options or create a zenstack-kit.config.ts file."
    );
  }

  if (!dialect) {
    throw new Error(
      "dialect is required. Provide it in options or create a zenstack-kit.config.ts file."
    );
  }

  if (dialect !== "sqlite" && !connectionUrl) {
    throw new Error(
      "connectionUrl is required for postgres/mysql. Provide it in options or in your config file."
    );
  }

  const migrationsTable = options.migrationsTable ?? "_prisma_migrations";
  const migrationsSchema = options.migrationsSchema ?? "public";

  // Preview mode
  if (options.preview) {
    const result = await previewPrismaMigrations({
      migrationsFolder,
      dialect,
      connectionUrl,
      databasePath,
      migrationsTable,
      migrationsSchema,
    });

    return { ...result, mode: "preview" };
  }

  // Apply mode
  const result = await applyPrismaMigrations({
    migrationsFolder,
    dialect,
    connectionUrl,
    databasePath,
    migrationsTable,
    migrationsSchema,
  });

  if (result.failed) {
    throw new Error(`Migration failed: ${result.failed.migrationName} - ${result.failed.error}`);
  }

  return { ...result, mode: "apply" };
}

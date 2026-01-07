/**
 * Configuration utilities for zenstack-kit
 *
 * Provides a type-safe way to define configuration similar to drizzle-kit's config.
 */

export interface ZenStackKitConfig {
  /** Path to ZenStack schema file */
  schema: string;
  /** Output directory for generated files */
  out: string;
  /** Database dialect */
  dialect?: "sqlite" | "postgres" | "mysql";
  /** Database connection string */
  dbCredentials?: {
    url?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  };
  /** Migration settings */
  migrations?: {
    /** Directory for migration files (default: ./prisma/migrations) */
    migrationsFolder?: string;
    /** Table name for migration metadata (default: _prisma_migrations) */
    migrationsTable?: string;
    /** Database schema for migrations table (PostgreSQL only, default: public) */
    migrationsSchema?: string;
  };
  /** Code generation settings */
  codegen?: {
    /** Use camelCase for column names */
    camelCase?: boolean;
    /** Generate index file */
    generateIndex?: boolean;
  };
  /** Enable verbose logging */
  verbose?: boolean;
  /** Enable strict mode */
  strict?: boolean;
}

/**
 * Define zenstack-kit configuration
 *
 * @example
 * ```ts
 * // zenstack-kit.config.ts
 * import { defineConfig } from "zenstack-kit";
 *
 * export default defineConfig({
 *   schema: "./prisma/schema.zmodel",
 *   out: "./src/db",
 *   dialect: "postgres",
 *   dbCredentials: {
 *     url: process.env.DATABASE_URL,
 *   },
 * });
 * ```
 */
export function defineConfig(config: ZenStackKitConfig): ZenStackKitConfig {
  return {
    // Default values
    dialect: "sqlite",
    verbose: false,
    strict: false,
    ...config,
    out: config.out ?? "./generated",
    migrations: {
      migrationsFolder: "./prisma/migrations",
      migrationsTable: "_prisma_migrations",
      migrationsSchema: "public",
      ...config.migrations,
    },
    codegen: {
      camelCase: true,
      generateIndex: true,
      ...config.codegen,
    },
  };
}

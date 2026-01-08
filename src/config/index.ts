/**
 * Configuration utilities for zenstack-kit
 *
 * Provides a type-safe way to define configuration similar to drizzle-kit's config.
 */

/** Base configuration shared across all dialects */
interface BaseConfig {
  /** Path to ZenStack schema file */
  schema: string;
  /** Output directory for generated files */
  out?: string;
  /** Migration settings */
  migrations?: {
    /** Directory for migration files (default: ./prisma/migrations) */
    migrationsFolder?: string;
    /** Table name for migration metadata (default: _prisma_migrations) */
    migrationsTable?: string;
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

/** SQLite-specific configuration */
interface SqliteConfig extends BaseConfig {
  dialect?: "sqlite";
  /** Database credentials for SQLite */
  dbCredentials?: {
    /** Path to SQLite database file */
    file?: string;
  };
}

/** PostgreSQL-specific configuration */
interface PostgresConfig extends BaseConfig {
  dialect: "postgres";
  /** Database credentials for PostgreSQL */
  dbCredentials?: {
    /** Connection URL */
    url?: string;
    /** Or individual connection parameters */
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  };
  /** Migration settings with PostgreSQL-specific options */
  migrations?: BaseConfig["migrations"] & {
    /** Database schema for migrations table (PostgreSQL only, default: public) */
    migrationsSchema?: string;
  };
}

/** MySQL-specific configuration */
interface MysqlConfig extends BaseConfig {
  dialect: "mysql";
  /** Database credentials for MySQL */
  dbCredentials?: {
    /** Connection URL */
    url?: string;
    /** Or individual connection parameters */
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  };
}

export type ZenStackKitConfig = SqliteConfig | PostgresConfig | MysqlConfig;

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
export function defineConfig<T extends ZenStackKitConfig>(config: T): T {
  const dialect = config.dialect ?? "sqlite";

  const baseMigrations = {
    migrationsFolder: "./prisma/migrations",
    migrationsTable: "_prisma_migrations",
    ...config.migrations,
  };

  // Add migrationsSchema only for PostgreSQL
  const migrations =
    dialect === "postgres"
      ? { migrationsSchema: "public", ...baseMigrations }
      : baseMigrations;

  return {
    dialect,
    verbose: false,
    strict: false,
    ...config,
    out: config.out ?? "./generated",
    migrations,
    codegen: {
      camelCase: true,
      generateIndex: true,
      ...config.codegen,
    },
  } as T;
}

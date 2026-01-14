import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { sql } from "kysely";
import type { KyselyDialect } from "../../sql/kysely-adapter.js";
import { createKyselyAdapter } from "../../sql/kysely-adapter.js";
import { calculateChecksum, readMigrationLog, type MigrationLogEntry } from "./log.js";

export interface ApplyPrismaMigrationsOptions {
  /** Migrations folder path */
  migrationsFolder: string;
  /** Database dialect */
  dialect: KyselyDialect;
  /** Database connection URL */
  connectionUrl?: string;
  /** SQLite database path */
  databasePath?: string;
  /** Migrations table name (default: _prisma_migrations) */
  migrationsTable?: string;
  /** Migrations schema (PostgreSQL only, default: public) */
  migrationsSchema?: string;
  /** Mark migrations as applied without executing SQL */
  markApplied?: boolean;
}

export interface ApplyPrismaMigrationsResult {
  applied: Array<{ migrationName: string; duration: number }>;
  alreadyApplied: string[];
  failed?: { migrationName: string; error: string };
  coherenceErrors?: MigrationCoherenceError[];
}

export interface MigrationCoherenceError {
  type: "missing_from_log" | "missing_from_db" | "missing_from_disk" | "order_mismatch" | "checksum_mismatch";
  migrationName: string;
  details: string;
}

export interface MigrationCoherenceResult {
  isCoherent: boolean;
  errors: MigrationCoherenceError[];
}

export interface PreviewPrismaMigrationsResult {
  pending: Array<{ name: string; sql: string }>;
  alreadyApplied: string[];
}

interface PrismaMigrationsRow {
  id: string;
  checksum: string;
  finished_at: string | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: string | null;
  started_at: string;
  applied_steps_count: number;
}

/**
 * Ensure _prisma_migrations table exists
 */
async function ensureMigrationsTable(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  tableName: string,
  schema: string | undefined,
  dialect: KyselyDialect
): Promise<void> {
  const fullTableName = schema && dialect === "postgres" ? `${schema}.${tableName}` : tableName;

  if (dialect === "sqlite") {
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`"${tableName}"`)} (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        finished_at TEXT,
        migration_name TEXT NOT NULL,
        logs TEXT,
        rolled_back_at TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `.execute(db);
  } else if (dialect === "postgres") {
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`"${schema}"."${tableName}"`)} (
        id VARCHAR(36) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        finished_at TIMESTAMPTZ,
        migration_name VARCHAR(255) NOT NULL,
        logs TEXT,
        rolled_back_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `.execute(db);
  } else {
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`\`${tableName}\``)} (
        id VARCHAR(36) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        finished_at DATETIME,
        migration_name VARCHAR(255) NOT NULL,
        logs TEXT,
        rolled_back_at DATETIME,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `.execute(db);
  }
}

/**
 * Get list of applied migrations from _prisma_migrations table
 */
async function getAppliedMigrations(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  tableName: string,
  schema: string | undefined,
  dialect: KyselyDialect
): Promise<Map<string, PrismaMigrationsRow>> {
  let result;
  if (dialect === "postgres" && schema) {
    result = await sql<PrismaMigrationsRow>`
      SELECT * FROM ${sql.raw(`"${schema}"."${tableName}"`)}
      WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
    `.execute(db);
  } else if (dialect === "sqlite") {
    result = await sql<PrismaMigrationsRow>`
      SELECT * FROM ${sql.raw(`"${tableName}"`)}
      WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
    `.execute(db);
  } else {
    result = await sql<PrismaMigrationsRow>`
      SELECT * FROM ${sql.raw(`\`${tableName}\``)}
      WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
    `.execute(db);
  }

  return new Map(result.rows.map((row) => [row.migration_name, row]));
}

/**
 * Record a migration in _prisma_migrations table
 */
async function recordMigration(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  tableName: string,
  schema: string | undefined,
  dialect: KyselyDialect,
  migrationName: string,
  checksum: string
): Promise<void> {
  const id = crypto.randomUUID();

  if (dialect === "postgres" && schema) {
    await sql`
      INSERT INTO ${sql.raw(`"${schema}"."${tableName}"`)} (id, checksum, migration_name, finished_at, applied_steps_count)
      VALUES (${id}, ${checksum}, ${migrationName}, now(), 1)
    `.execute(db);
  } else if (dialect === "sqlite") {
    await sql`
      INSERT INTO ${sql.raw(`"${tableName}"`)} (id, checksum, migration_name, finished_at, applied_steps_count)
      VALUES (${id}, ${checksum}, ${migrationName}, datetime('now'), 1)
    `.execute(db);
  } else {
    await sql`
      INSERT INTO ${sql.raw(`\`${tableName}\``)} (id, checksum, migration_name, finished_at, applied_steps_count)
      VALUES (${id}, ${checksum}, ${migrationName}, NOW(), 1)
    `.execute(db);
  }
}

/**
 * Validate that the database's applied migrations are coherent with the migration log.
 *
 * Coherence rules:
 * 1. Every migration applied in the DB must exist in the migration log
 * 2. Applied migrations must be a prefix of the log (no gaps)
 * 3. Checksums must match for applied migrations
 */
function validateMigrationCoherence(
  appliedMigrations: Map<string, PrismaMigrationsRow>,
  migrationLog: MigrationLogEntry[],
  migrationFolders: string[]
): MigrationCoherenceResult {
  const errors: MigrationCoherenceError[] = [];

  // Build a set of log migration names for quick lookup
  const logMigrationNames = new Set(migrationLog.map((e) => e.name));
  const folderNames = new Set(migrationFolders);

  for (const entry of migrationLog) {
    if (!folderNames.has(entry.name)) {
      errors.push({
        type: "missing_from_disk",
        migrationName: entry.name,
        details: `Migration "${entry.name}" exists in migration log but not on disk`,
      });
    }
  }

  // Check 1: Every applied migration must exist in the log
  for (const [migrationName] of appliedMigrations) {
    if (!logMigrationNames.has(migrationName)) {
      errors.push({
        type: "missing_from_log",
        migrationName,
        details: `Migration "${migrationName}" exists in database but not in migration log`,
      });
    }
  }

  // If there are migrations missing from the log, return early
  // (other checks don't make sense if the log is incomplete)
  if (errors.length > 0) {
    return { isCoherent: false, errors };
  }

  // Check 2: Applied migrations should be a continuous prefix of the log
  // i.e., if migration N is applied, all migrations before N in the log must also be applied
  let lastAppliedIndex = -1;
  for (let i = 0; i < migrationLog.length; i++) {
    const logEntry = migrationLog[i];
    const isApplied = appliedMigrations.has(logEntry.name);

    if (isApplied) {
      // Check for gaps: if this is applied, all previous should be applied
      if (lastAppliedIndex !== i - 1) {
        // There's a gap - find the missing migrations
        for (let j = lastAppliedIndex + 1; j < i; j++) {
          const missing = migrationLog[j];
          errors.push({
            type: "order_mismatch",
            migrationName: missing.name,
            details: `Migration "${missing.name}" is in the log but not applied, yet later migration "${logEntry.name}" is applied`,
          });
        }
      }
      lastAppliedIndex = i;

      // Check 3: Checksum validation for applied migrations
      const dbRow = appliedMigrations.get(logEntry.name)!;
      if (dbRow.checksum !== logEntry.checksum) {
        errors.push({
          type: "checksum_mismatch",
          migrationName: logEntry.name,
          details: `Checksum mismatch for "${logEntry.name}": database has ${dbRow.checksum.slice(0, 8)}..., log has ${logEntry.checksum.slice(0, 8)}...`,
        });
      }
    }
  }

  return {
    isCoherent: errors.length === 0,
    errors,
  };
}

/**
 * Execute raw SQL using the database driver directly
 * This bypasses Kysely for DDL statements which don't work reliably with sql.raw()
 */
async function executeRawSql(
  dialect: KyselyDialect,
  sqlContent: string,
  options: { connectionUrl?: string; databasePath?: string }
): Promise<void> {
  if (dialect === "sqlite") {
    const { default: Database } = await import("better-sqlite3");
    const sqliteDb = new Database(options.databasePath || ":memory:");
    try {
      // better-sqlite3's exec() handles multiple statements properly
      sqliteDb.exec(sqlContent);
    } finally {
      sqliteDb.close();
    }
  } else if (dialect === "postgres") {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: options.connectionUrl });
    const client = await pool.connect();
    try {
      // PostgreSQL supports transactional DDL, so wrap migration in a transaction
      await client.query("BEGIN");
      await client.query(sqlContent);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  } else if (dialect === "mysql") {
    // Use mysql2 with promise wrapper
    const mysql = await import("mysql2");
    const pool = mysql.createPool({ uri: options.connectionUrl });
    const promisePool = pool.promise();
    try {
      // MySQL needs statements executed one at a time
      const statements = sqlContent
        .split(/;(?:\s*\n|\s*$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--"));
      for (const statement of statements) {
        await promisePool.query(statement);
      }
    } finally {
      await pool.promise().end();
    }
  }
}

/**
 * Apply pending Prisma migrations
 */
export async function applyPrismaMigrations(
  options: ApplyPrismaMigrationsOptions
): Promise<ApplyPrismaMigrationsResult> {
  const migrationsTable = options.migrationsTable ?? "_prisma_migrations";
  const migrationsSchema = options.migrationsSchema ?? "public";

  const { db, destroy } = await createKyselyAdapter({
    dialect: options.dialect,
    connectionUrl: options.connectionUrl,
    databasePath: options.databasePath,
  });

  try {
    // Ensure migrations table exists
    await ensureMigrationsTable(db, migrationsTable, migrationsSchema, options.dialect);

    // Get already applied migrations
    const appliedMigrations = await getAppliedMigrations(
      db,
      migrationsTable,
      migrationsSchema,
      options.dialect
    );

    // Read migration folders
    const entries = await fs.readdir(options.migrationsFolder, { withFileTypes: true });
    const migrationFolders = entries
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();

    const migrationFoldersWithSql: string[] = [];
    for (const folderName of migrationFolders) {
      const sqlPath = path.join(options.migrationsFolder, folderName, "migration.sql");
      try {
        await fs.access(sqlPath);
        migrationFoldersWithSql.push(folderName);
      } catch {
        // Missing migration.sql; coherence check will flag if it's in the log
      }
    }

    // Read migration log and validate coherence
    const migrationLog = await readMigrationLog(options.migrationsFolder);
    const coherence = validateMigrationCoherence(
      appliedMigrations,
      migrationLog,
      migrationFoldersWithSql
    );
    if (!coherence.isCoherent) {
      return {
        applied: [],
        alreadyApplied: [],
        coherenceErrors: coherence.errors,
      };
    }

    const result: ApplyPrismaMigrationsResult = {
      applied: [],
      alreadyApplied: [],
    };

    for (const folderName of migrationFoldersWithSql) {
      if (appliedMigrations.has(folderName)) {
        result.alreadyApplied.push(folderName);
        continue;
      }

      const sqlPath = path.join(options.migrationsFolder, folderName, "migration.sql");
      let sqlContent: string;
      try {
        sqlContent = await fs.readFile(sqlPath, "utf-8");
      } catch {
        continue; // Skip if no migration.sql
      }

      const checksum = calculateChecksum(sqlContent);

      // Verify checksum against migration log (migrationLog already read above)
      const logEntry = migrationLog.find((m) => m.name === folderName);
      if (logEntry && logEntry.checksum !== checksum) {
        result.failed = {
          migrationName: folderName,
          error:
            `Checksum mismatch for migration ${folderName}.\n` +
            `Expected: ${logEntry.checksum}\n` +
            `Found: ${checksum}\n` +
            `The migration file may have been modified after generation.\n` +
            `If you intended this, run 'zenstack-kit migrate rehash' to rebuild log checksums.`,
        };
        break;
      }

      const startTime = Date.now();

      try {
        if (!options.markApplied) {
          // Execute the migration SQL using direct driver access
          await executeRawSql(options.dialect, sqlContent, {
            connectionUrl: options.connectionUrl,
            databasePath: options.databasePath,
          });
        }

        // Record the migration (still use Kysely for this since it's simple INSERT)
        await recordMigration(db, migrationsTable, migrationsSchema, options.dialect, folderName, checksum);

        result.applied.push({
          migrationName: folderName,
          duration: Date.now() - startTime,
        });
      } catch (error) {
        result.failed = {
          migrationName: folderName,
          error: error instanceof Error ? error.message : String(error),
        };
        break; // Stop on first failure
      }
    }

    return result;
  } finally {
    await destroy();
  }
}

/**
 * Preview pending migrations without applying them
 */
export async function previewPrismaMigrations(
  options: ApplyPrismaMigrationsOptions
): Promise<PreviewPrismaMigrationsResult> {
  const migrationsTable = options.migrationsTable ?? "_prisma_migrations";
  const migrationsSchema = options.migrationsSchema ?? "public";

  const { db, destroy } = await createKyselyAdapter({
    dialect: options.dialect,
    connectionUrl: options.connectionUrl,
    databasePath: options.databasePath,
  });

  try {
    // Ensure migrations table exists
    await ensureMigrationsTable(db, migrationsTable, migrationsSchema, options.dialect);

    // Get already applied migrations
    const appliedMigrations = await getAppliedMigrations(
      db,
      migrationsTable,
      migrationsSchema,
      options.dialect
    );

    // Read migration folders
    const entries = await fs.readdir(options.migrationsFolder, { withFileTypes: true });
    const migrationFolders = entries
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();

    const result: PreviewPrismaMigrationsResult = {
      pending: [],
      alreadyApplied: [],
    };

    for (const folderName of migrationFolders) {
      if (appliedMigrations.has(folderName)) {
        result.alreadyApplied.push(folderName);
        continue;
      }

      const sqlPath = path.join(options.migrationsFolder, folderName, "migration.sql");
      let sqlContent: string;
      try {
        sqlContent = await fs.readFile(sqlPath, "utf-8");
      } catch {
        continue; // Skip if no migration.sql
      }

      result.pending.push({
        name: folderName,
        sql: sqlContent,
      });
    }

    return result;
  } finally {
    await destroy();
  }
}

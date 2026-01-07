/**
 * Prisma-compatible migrations
 *
 * Generates migrations in Prisma format:
 * - Folder structure: migrations/<timestamp>_<name>/migration.sql
 * - Tracks migrations in _prisma_migrations table
 * - Compatible with `prisma migrate deploy`
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { sql } from "kysely";
import type { KyselyDialect } from "./kysely-adapter.js";
import { createKyselyAdapter } from "./kysely-adapter.js";
import type { SchemaSnapshot, SchemaTable, SchemaColumn } from "./schema-snapshot.js";
import { generateSchemaSnapshot, createSnapshot, type SchemaSnapshotFile } from "./schema-snapshot.js";
import {
  compileCreateTable,
  compileDropTable,
  compileAddColumn,
  compileDropColumn,
  compileRenameTable,
  compileRenameColumn,
  compileCreateIndex,
  compileDropIndex,
  compileAddUniqueConstraint,
  compileDropConstraint,
  compileAddForeignKeyConstraint,
  compileAddPrimaryKeyConstraint,
  compileAlterColumn,
} from "./sql-compiler.js";

export interface PrismaMigrationOptions {
  /** Migration name */
  name: string;
  /** Path to ZenStack schema file */
  schemaPath: string;
  /** Output directory for migration files */
  outputPath: string;
  /** Database dialect for SQL generation */
  dialect: KyselyDialect;
  /** Table rename mappings */
  renameTables?: Array<{ from: string; to: string }>;
  /** Column rename mappings */
  renameColumns?: Array<{ table: string; from: string; to: string }>;
}

export interface PrismaMigration {
  /** Migration folder name (timestamp_name) */
  folderName: string;
  /** Full path to migration folder */
  folderPath: string;
  /** SQL content */
  sql: string;
  /** Timestamp */
  timestamp: number;
}

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
}

export interface ApplyPrismaMigrationsResult {
  applied: Array<{ migrationName: string; duration: number }>;
  alreadyApplied: string[];
  failed?: { migrationName: string; error: string };
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
 * Generate timestamp string for migration folder name
 */
function generateTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

/**
 * Get paths for snapshot file
 */
function getSnapshotPaths(outputPath: string) {
  const metaDir = path.join(outputPath, "meta");
  return {
    metaDir,
    snapshotPath: path.join(metaDir, "_snapshot.json"),
  };
}

/**
 * Read existing snapshot
 */
async function readSnapshot(snapshotPath: string): Promise<SchemaSnapshotFile | null> {
  try {
    const content = await fs.readFile(snapshotPath, "utf-8");
    const snapshot = JSON.parse(content) as SchemaSnapshotFile;
    if (!snapshot || snapshot.version !== 2 || !snapshot.schema) {
      throw new Error("Snapshot format is invalid");
    }
    return snapshot;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Write snapshot to file
 */
async function writeSnapshot(snapshotPath: string, schema: SchemaSnapshot): Promise<void> {
  const snapshot = createSnapshot(schema);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
}

/**
 * Diff two schemas and return the changes
 */
function diffSchemas(previous: SchemaSnapshot | null, current: SchemaSnapshot) {
  const previousModels = new Map<string, SchemaTable>();
  const currentModels = new Map<string, SchemaTable>();

  previous?.tables.forEach((model) => previousModels.set(model.name, model));
  current.tables.forEach((model) => currentModels.set(model.name, model));

  const addedModels: SchemaTable[] = [];
  const removedModels: SchemaTable[] = [];

  for (const [tableName, model] of currentModels.entries()) {
    if (!previousModels.has(tableName)) {
      addedModels.push(model);
    }
  }

  for (const [tableName, model] of previousModels.entries()) {
    if (!currentModels.has(tableName)) {
      removedModels.push(model);
    }
  }

  // Field-level changes for existing tables
  const addedFields: Array<{ tableName: string; column: SchemaColumn }> = [];
  const removedFields: Array<{ tableName: string; column: SchemaColumn }> = [];
  const alteredFields: Array<{
    tableName: string;
    columnName: string;
    previous: SchemaColumn;
    current: SchemaColumn;
  }> = [];

  // Constraint changes
  const addedUniqueConstraints: Array<{
    tableName: string;
    constraint: { name: string; columns: string[] };
  }> = [];
  const removedUniqueConstraints: Array<{
    tableName: string;
    constraint: { name: string; columns: string[] };
  }> = [];
  const addedIndexes: Array<{
    tableName: string;
    index: { name: string; columns: string[] };
  }> = [];
  const removedIndexes: Array<{
    tableName: string;
    index: { name: string; columns: string[] };
  }> = [];
  const addedForeignKeys: Array<{
    tableName: string;
    foreignKey: {
      name: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    };
  }> = [];
  const removedForeignKeys: Array<{
    tableName: string;
    foreignKey: {
      name: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    };
  }> = [];
  const primaryKeyChanges: Array<{
    tableName: string;
    previous?: { name: string; columns: string[] };
    current?: { name: string; columns: string[] };
  }> = [];

  for (const [tableName, currentModel] of currentModels.entries()) {
    const previousModel = previousModels.get(tableName);
    if (!previousModel) continue;

    // Field changes
    const previousFields = new Map(previousModel.columns.map((f) => [f.name, f]));
    const currentFields = new Map(currentModel.columns.map((f) => [f.name, f]));

    for (const [columnName, column] of currentFields.entries()) {
      if (!previousFields.has(columnName)) {
        addedFields.push({ tableName, column });
      }
    }

    for (const [columnName, column] of previousFields.entries()) {
      if (!currentFields.has(columnName)) {
        removedFields.push({ tableName, column });
      }
    }

    for (const [columnName, currentColumn] of currentFields.entries()) {
      const previousColumn = previousFields.get(columnName);
      if (!previousColumn) continue;

      if (
        previousColumn.type !== currentColumn.type ||
        previousColumn.notNull !== currentColumn.notNull ||
        previousColumn.default !== currentColumn.default
      ) {
        alteredFields.push({
          tableName,
          columnName,
          previous: previousColumn,
          current: currentColumn,
        });
      }
    }

    // Unique constraint changes
    const prevUnique = new Map(previousModel.uniqueConstraints.map((c) => [c.name, c]));
    const currUnique = new Map(currentModel.uniqueConstraints.map((c) => [c.name, c]));

    for (const [name, constraint] of currUnique.entries()) {
      if (!prevUnique.has(name)) {
        addedUniqueConstraints.push({ tableName, constraint });
      }
    }
    for (const [name, constraint] of prevUnique.entries()) {
      if (!currUnique.has(name)) {
        removedUniqueConstraints.push({ tableName, constraint });
      }
    }

    // Index changes
    const prevIndexes = new Map(previousModel.indexes.map((i) => [i.name, i]));
    const currIndexes = new Map(currentModel.indexes.map((i) => [i.name, i]));

    for (const [name, index] of currIndexes.entries()) {
      if (!prevIndexes.has(name)) {
        addedIndexes.push({ tableName, index });
      }
    }
    for (const [name, index] of prevIndexes.entries()) {
      if (!currIndexes.has(name)) {
        removedIndexes.push({ tableName, index });
      }
    }

    // Foreign key changes
    const prevFks = new Map(previousModel.foreignKeys.map((f) => [f.name, f]));
    const currFks = new Map(currentModel.foreignKeys.map((f) => [f.name, f]));

    for (const [name, fk] of currFks.entries()) {
      if (!prevFks.has(name)) {
        addedForeignKeys.push({ tableName, foreignKey: fk });
      }
    }
    for (const [name, fk] of prevFks.entries()) {
      if (!currFks.has(name)) {
        removedForeignKeys.push({ tableName, foreignKey: fk });
      }
    }

    // Primary key changes
    const prevPk = previousModel.primaryKey;
    const currPk = currentModel.primaryKey;
    const pkEqual =
      (prevPk?.name ?? "") === (currPk?.name ?? "") &&
      JSON.stringify(prevPk?.columns ?? []) === JSON.stringify(currPk?.columns ?? []);

    if (!pkEqual) {
      primaryKeyChanges.push({
        tableName,
        previous: prevPk,
        current: currPk,
      });
    }
  }

  return {
    addedModels,
    removedModels,
    addedFields,
    removedFields,
    alteredFields,
    addedUniqueConstraints,
    removedUniqueConstraints,
    addedIndexes,
    removedIndexes,
    addedForeignKeys,
    removedForeignKeys,
    primaryKeyChanges,
    renamedTables: [] as Array<{ from: string; to: string }>,
    renamedColumns: [] as Array<{ tableName: string; from: string; to: string }>,
  };
}

/**
 * Build SQL statements from diff
 */
function buildSqlStatements(
  diff: ReturnType<typeof diffSchemas>,
  dialect: KyselyDialect
): { up: string[]; down: string[] } {
  const up: string[] = [];
  const down: string[] = [];
  const compileOpts = { dialect };

  // Table renames
  for (const rename of diff.renamedTables) {
    up.push(compileRenameTable(rename.from, rename.to, compileOpts));
    down.unshift(compileRenameTable(rename.to, rename.from, compileOpts));
  }

  // Column renames
  for (const rename of diff.renamedColumns) {
    up.push(compileRenameColumn(rename.tableName, rename.from, rename.to, compileOpts));
    down.unshift(compileRenameColumn(rename.tableName, rename.to, rename.from, compileOpts));
  }

  // Create tables
  for (const model of diff.addedModels) {
    up.push(compileCreateTable(model, compileOpts));
    down.unshift(compileDropTable(model.name, compileOpts));
  }

  // Drop tables
  for (const model of diff.removedModels) {
    up.push(compileDropTable(model.name, compileOpts));
    down.unshift(compileCreateTable(model, compileOpts));
  }

  // Primary key changes (drop old first)
  for (const change of diff.primaryKeyChanges) {
    if (change.previous) {
      up.push(compileDropConstraint(change.tableName, change.previous.name, compileOpts));
      down.unshift(
        compileAddPrimaryKeyConstraint(
          change.tableName,
          change.previous.name,
          change.previous.columns,
          compileOpts
        )
      );
    }
  }

  // Drop foreign keys first (before dropping columns)
  for (const { tableName, foreignKey } of diff.removedForeignKeys) {
    up.push(compileDropConstraint(tableName, foreignKey.name, compileOpts));
    down.unshift(
      compileAddForeignKeyConstraint(
        tableName,
        foreignKey.name,
        foreignKey.columns,
        foreignKey.referencedTable,
        foreignKey.referencedColumns,
        compileOpts
      )
    );
  }

  // Drop unique constraints
  for (const { tableName, constraint } of diff.removedUniqueConstraints) {
    up.push(compileDropConstraint(tableName, constraint.name, compileOpts));
    down.unshift(
      compileAddUniqueConstraint(tableName, constraint.name, constraint.columns, compileOpts)
    );
  }

  // Drop indexes
  for (const { tableName, index } of diff.removedIndexes) {
    up.push(compileDropIndex(index.name, compileOpts));
    down.unshift(compileCreateIndex(tableName, index.name, index.columns, compileOpts));
  }

  // Add columns
  for (const { tableName, column } of diff.addedFields) {
    up.push(compileAddColumn(tableName, column, compileOpts));
    down.unshift(compileDropColumn(tableName, column.name, compileOpts));
  }

  // Drop columns
  for (const { tableName, column } of diff.removedFields) {
    up.push(compileDropColumn(tableName, column.name, compileOpts));
    down.unshift(compileAddColumn(tableName, column, compileOpts));
  }

  // Alter columns
  for (const change of diff.alteredFields) {
    const typeChanged = change.previous.type !== change.current.type;
    const nullChanged = change.previous.notNull !== change.current.notNull;
    const defaultChanged = change.previous.default !== change.current.default;

    if (typeChanged) {
      up.push(
        ...compileAlterColumn(
          change.tableName,
          change.columnName,
          { setType: change.current.type },
          compileOpts
        )
      );
      down.unshift(
        ...compileAlterColumn(
          change.tableName,
          change.columnName,
          { setType: change.previous.type },
          compileOpts
        )
      );
    }

    if (nullChanged) {
      if (change.current.notNull) {
        up.push(
          ...compileAlterColumn(change.tableName, change.columnName, { setNotNull: true }, compileOpts)
        );
        down.unshift(
          ...compileAlterColumn(change.tableName, change.columnName, { dropNotNull: true }, compileOpts)
        );
      } else {
        up.push(
          ...compileAlterColumn(change.tableName, change.columnName, { dropNotNull: true }, compileOpts)
        );
        down.unshift(
          ...compileAlterColumn(change.tableName, change.columnName, { setNotNull: true }, compileOpts)
        );
      }
    }

    if (defaultChanged) {
      if (change.current.default !== undefined) {
        up.push(
          ...compileAlterColumn(
            change.tableName,
            change.columnName,
            { setDefault: change.current.default },
            compileOpts
          )
        );
      } else {
        up.push(
          ...compileAlterColumn(change.tableName, change.columnName, { dropDefault: true }, compileOpts)
        );
      }

      if (change.previous.default !== undefined) {
        down.unshift(
          ...compileAlterColumn(
            change.tableName,
            change.columnName,
            { setDefault: change.previous.default },
            compileOpts
          )
        );
      } else {
        down.unshift(
          ...compileAlterColumn(change.tableName, change.columnName, { dropDefault: true }, compileOpts)
        );
      }
    }
  }

  // Primary key changes (add new)
  for (const change of diff.primaryKeyChanges) {
    if (change.current) {
      up.push(
        compileAddPrimaryKeyConstraint(
          change.tableName,
          change.current.name,
          change.current.columns,
          compileOpts
        )
      );
      down.unshift(compileDropConstraint(change.tableName, change.current.name, compileOpts));
    }
  }

  // Add unique constraints
  for (const { tableName, constraint } of diff.addedUniqueConstraints) {
    up.push(compileAddUniqueConstraint(tableName, constraint.name, constraint.columns, compileOpts));
    down.unshift(compileDropConstraint(tableName, constraint.name, compileOpts));
  }

  // Add indexes
  for (const { tableName, index } of diff.addedIndexes) {
    up.push(compileCreateIndex(tableName, index.name, index.columns, compileOpts));
    down.unshift(compileDropIndex(index.name, compileOpts));
  }

  // Add foreign keys
  for (const { tableName, foreignKey } of diff.addedForeignKeys) {
    up.push(
      compileAddForeignKeyConstraint(
        tableName,
        foreignKey.name,
        foreignKey.columns,
        foreignKey.referencedTable,
        foreignKey.referencedColumns,
        compileOpts
      )
    );
    down.unshift(compileDropConstraint(tableName, foreignKey.name, compileOpts));
  }

  return { up, down };
}

/**
 * Create a Prisma-compatible migration
 */
export async function createPrismaMigration(
  options: PrismaMigrationOptions
): Promise<PrismaMigration | null> {
  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath);
  const previousSnapshot = await readSnapshot(snapshotPath);

  let diff = diffSchemas(previousSnapshot?.schema ?? null, currentSchema);

  // Apply rename mappings
  if (options.renameTables?.length || options.renameColumns?.length) {
    // Handle table renames
    for (const mapping of options.renameTables ?? []) {
      const removedIdx = diff.removedModels.findIndex((m) => m.name === mapping.from);
      const addedIdx = diff.addedModels.findIndex((m) => m.name === mapping.to);
      if (removedIdx !== -1 && addedIdx !== -1) {
        diff.removedModels.splice(removedIdx, 1);
        diff.addedModels.splice(addedIdx, 1);
        diff.renamedTables.push(mapping);
      }
    }

    // Handle column renames
    for (const mapping of options.renameColumns ?? []) {
      const removedIdx = diff.removedFields.findIndex(
        (f) => f.tableName === mapping.table && f.column.name === mapping.from
      );
      const addedIdx = diff.addedFields.findIndex(
        (f) => f.tableName === mapping.table && f.column.name === mapping.to
      );
      if (removedIdx !== -1 && addedIdx !== -1) {
        diff.removedFields.splice(removedIdx, 1);
        diff.addedFields.splice(addedIdx, 1);
        diff.renamedColumns.push({ tableName: mapping.table, from: mapping.from, to: mapping.to });
      }
    }
  }

  const { up, down } = buildSqlStatements(diff, options.dialect);

  if (up.length === 0) {
    return null;
  }

  const timestamp = Date.now();
  const timestampStr = generateTimestamp();
  const safeName = options.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const folderName = `${timestampStr}_${safeName}`;
  const folderPath = path.join(options.outputPath, folderName);

  // Build migration.sql content with comments
  const sqlContent = [
    `-- Migration: ${options.name}`,
    `-- Generated at: ${new Date(timestamp).toISOString()}`,
    "",
    ...up,
    "",
  ].join("\n");

  // Create migration folder and file
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(path.join(folderPath, "migration.sql"), sqlContent, "utf-8");

  // Update snapshot
  await writeSnapshot(snapshotPath, currentSchema);

  return {
    folderName,
    folderPath,
    sql: sqlContent,
    timestamp,
  };
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
 * Calculate SHA256 checksum of migration SQL
 */
function calculateChecksum(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex");
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
    try {
      await pool.query(sqlContent);
    } finally {
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

    const result: ApplyPrismaMigrationsResult = {
      applied: [],
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

      const checksum = calculateChecksum(sqlContent);
      const startTime = Date.now();

      try {
        // Execute the migration SQL using direct driver access
        await executeRawSql(options.dialect, sqlContent, {
          connectionUrl: options.connectionUrl,
          databasePath: options.databasePath,
        });

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
 * Check if there are schema changes
 */
export async function hasPrismaSchemaChanges(options: {
  schemaPath: string;
  outputPath: string;
}): Promise<boolean> {
  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath);
  const previousSnapshot = await readSnapshot(snapshotPath);

  const diff = diffSchemas(previousSnapshot?.schema ?? null, currentSchema);

  return (
    diff.addedModels.length > 0 ||
    diff.removedModels.length > 0 ||
    diff.addedFields.length > 0 ||
    diff.removedFields.length > 0 ||
    diff.alteredFields.length > 0 ||
    diff.addedUniqueConstraints.length > 0 ||
    diff.removedUniqueConstraints.length > 0 ||
    diff.addedIndexes.length > 0 ||
    diff.removedIndexes.length > 0 ||
    diff.addedForeignKeys.length > 0 ||
    diff.removedForeignKeys.length > 0 ||
    diff.primaryKeyChanges.length > 0
  );
}

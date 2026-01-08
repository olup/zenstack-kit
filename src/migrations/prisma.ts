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
import type { KyselyDialect } from "../sql/kysely-adapter.js";
import { createKyselyAdapter } from "../sql/kysely-adapter.js";
import type { SchemaSnapshot, SchemaTable, SchemaColumn } from "../schema/snapshot.js";
import { generateSchemaSnapshot, createSnapshot, type SchemaSnapshotFile } from "../schema/snapshot.js";
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
} from "../sql/compiler.js";

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
 * Generate timestamp string for migration folder name
 */
export function generateTimestamp(): string {
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
export async function writeSnapshot(snapshotPath: string, schema: SchemaSnapshot): Promise<void> {
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
 * Topologically sort tables so that referenced tables come before tables that reference them.
 * Tables with no foreign keys come first, then tables that only reference already-ordered tables.
 */
function sortTablesByDependencies(tables: SchemaTable[]): SchemaTable[] {
  const tableMap = new Map(tables.map((t) => [t.name, t]));
  const sorted: SchemaTable[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(tableName: string): void {
    if (visited.has(tableName)) return;
    if (visiting.has(tableName)) {
      // Circular dependency - just add it and let the DB handle it
      return;
    }

    const table = tableMap.get(tableName);
    if (!table) return;

    visiting.add(tableName);

    // Visit all tables this table references first
    for (const fk of table.foreignKeys) {
      if (tableMap.has(fk.referencedTable) && fk.referencedTable !== tableName) {
        visit(fk.referencedTable);
      }
    }

    visiting.delete(tableName);
    visited.add(tableName);
    sorted.push(table);
  }

  for (const table of tables) {
    visit(table.name);
  }

  return sorted;
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

  // Create tables (sorted by dependency order so referenced tables are created first)
  const sortedAddedModels = sortTablesByDependencies(diff.addedModels);
  for (const model of sortedAddedModels) {
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

  // Append to migration log
  const checksum = calculateChecksum(sqlContent);
  await appendToMigrationLog(options.outputPath, { name: folderName, checksum });

  return {
    folderName,
    folderPath,
    sql: sqlContent,
    timestamp,
  };
}

export interface CreateInitialMigrationOptions {
  /** Migration name (default: "init") */
  name?: string;
  /** Path to ZenStack schema file */
  schemaPath: string;
  /** Output directory for migration files */
  outputPath: string;
  /** Database dialect for SQL generation */
  dialect: KyselyDialect;
}

/**
 * Create an initial migration that creates all tables from scratch.
 * This is used when initializing a project where the database is empty.
 */
export async function createInitialMigration(
  options: CreateInitialMigrationOptions
): Promise<PrismaMigration> {
  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath);

  // Diff against empty schema to get full creation SQL
  const diff = diffSchemas(null, currentSchema);
  const { up } = buildSqlStatements(diff, options.dialect);

  const timestamp = Date.now();
  const timestampStr = generateTimestamp();
  const safeName = (options.name ?? "init").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const folderName = `${timestampStr}_${safeName}`;
  const folderPath = path.join(options.outputPath, folderName);

  // Build migration.sql content with comments
  const sqlContent = [
    `-- Migration: ${options.name ?? "init"}`,
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

  // Append to migration log
  const checksum = calculateChecksum(sqlContent);
  await appendToMigrationLog(options.outputPath, { name: folderName, checksum });

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
export function calculateChecksum(sql: string): string {
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

      // Verify checksum against migration log
      const migrationLog = await readMigrationLog(options.migrationsFolder);
      const logEntry = migrationLog.find((m) => m.name === folderName);
      if (logEntry && logEntry.checksum !== checksum) {
        result.failed = {
          migrationName: folderName,
          error:
            `Checksum mismatch for migration ${folderName}.\n` +
            `Expected: ${logEntry.checksum}\n` +
            `Found: ${checksum}\n` +
            `The migration file may have been modified after generation.`,
        };
        break;
      }

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

// ============================================================================
// Potential Rename Detection
// ============================================================================

export interface PotentialTableRename {
  from: string;
  to: string;
}

export interface PotentialColumnRename {
  table: string;
  from: string;
  to: string;
}

export interface PotentialRenames {
  tables: PotentialTableRename[];
  columns: PotentialColumnRename[];
}

/**
 * Detect potential renames by finding removed+added pairs.
 * A table rename is detected when one table is removed and one is added.
 * A column rename is detected when within the same table, one column is removed and one is added.
 */
export async function detectPotentialRenames(options: {
  schemaPath: string;
  outputPath: string;
}): Promise<PotentialRenames> {
  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath);
  const previousSnapshot = await readSnapshot(snapshotPath);

  const diff = diffSchemas(previousSnapshot?.schema ?? null, currentSchema);

  const result: PotentialRenames = {
    tables: [],
    columns: [],
  };

  // Detect potential table renames: one removed + one added
  // For simplicity, if there's exactly one removed and one added, suggest it as a rename
  // For multiple, pair them up by order (user can disambiguate)
  const minTablePairs = Math.min(diff.removedModels.length, diff.addedModels.length);
  for (let i = 0; i < minTablePairs; i++) {
    result.tables.push({
      from: diff.removedModels[i].name,
      to: diff.addedModels[i].name,
    });
  }

  // Detect potential column renames within same table
  // Group removed/added fields by table
  const removedByTable = new Map<string, string[]>();
  const addedByTable = new Map<string, string[]>();

  for (const { tableName, column } of diff.removedFields) {
    if (!removedByTable.has(tableName)) {
      removedByTable.set(tableName, []);
    }
    removedByTable.get(tableName)!.push(column.name);
  }

  for (const { tableName, column } of diff.addedFields) {
    if (!addedByTable.has(tableName)) {
      addedByTable.set(tableName, []);
    }
    addedByTable.get(tableName)!.push(column.name);
  }

  // For each table with both removed and added columns, suggest renames
  for (const [tableName, removed] of removedByTable.entries()) {
    const added = addedByTable.get(tableName) || [];
    const minPairs = Math.min(removed.length, added.length);
    for (let i = 0; i < minPairs; i++) {
      result.columns.push({
        table: tableName,
        from: removed[i],
        to: added[i],
      });
    }
  }

  return result;
}

// ============================================================================
// Migration Log
// ============================================================================

export interface MigrationLogEntry {
  /** Migration folder name e.g. "20260108120000_init" */
  name: string;
  /** SHA256 checksum of migration.sql content (64 hex chars) */
  checksum: string;
}

const MIGRATION_LOG_HEADER = `# zenstack-kit migration log
# Format: <migration_name> <checksum>
`;

/**
 * Get the path to the migration log file
 */
export function getMigrationLogPath(outputPath: string): string {
  return path.join(outputPath, "meta", "_migration_log");
}

/**
 * Parse migration log content into entries
 */
function parseMigrationLog(content: string): MigrationLogEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [name, checksum] = line.split(" ");
      return { name, checksum };
    })
    .filter((entry) => entry.name && entry.checksum);
}

/**
 * Serialize migration log entries to string
 */
function serializeMigrationLog(entries: MigrationLogEntry[]): string {
  const lines = entries.map((e) => `${e.name} ${e.checksum}`).join("\n");
  return MIGRATION_LOG_HEADER + lines + (lines.length > 0 ? "\n" : "");
}

/**
 * Read migration log file
 */
export async function readMigrationLog(outputPath: string): Promise<MigrationLogEntry[]> {
  const logPath = getMigrationLogPath(outputPath);
  try {
    const content = await fs.readFile(logPath, "utf-8");
    return parseMigrationLog(content);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Write migration log file
 */
export async function writeMigrationLog(outputPath: string, entries: MigrationLogEntry[]): Promise<void> {
  const logPath = getMigrationLogPath(outputPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, serializeMigrationLog(entries), "utf-8");
}

/**
 * Append a single entry to the migration log
 */
export async function appendToMigrationLog(outputPath: string, entry: MigrationLogEntry): Promise<void> {
  const entries = await readMigrationLog(outputPath);
  entries.push(entry);
  await writeMigrationLog(outputPath, entries);
}

/**
 * Scan migration folders and compute checksums for each
 */
export async function scanMigrationFolders(outputPath: string): Promise<MigrationLogEntry[]> {
  const entries: MigrationLogEntry[] = [];

  try {
    const dirEntries = await fs.readdir(outputPath, { withFileTypes: true });
    const migrationFolders = dirEntries
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();

    for (const folderName of migrationFolders) {
      const sqlPath = path.join(outputPath, folderName, "migration.sql");
      try {
        const sqlContent = await fs.readFile(sqlPath, "utf-8");
        const checksum = calculateChecksum(sqlContent);
        entries.push({ name: folderName, checksum });
      } catch {
        // Skip folders without migration.sql
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries;
}

/**
 * Check if snapshot exists
 */
export async function hasSnapshot(outputPath: string): Promise<boolean> {
  const { snapshotPath } = getSnapshotPaths(outputPath);
  try {
    await fs.access(snapshotPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize snapshot from schema without generating migration
 */
export async function initializeSnapshot(options: {
  schemaPath: string;
  outputPath: string;
}): Promise<{ snapshotPath: string; tableCount: number }> {
  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath);

  await writeSnapshot(snapshotPath, currentSchema);

  return {
    snapshotPath,
    tableCount: currentSchema.tables.length,
  };
}

/**
 * Export getSnapshotPaths for external use
 */
export { getSnapshotPaths };

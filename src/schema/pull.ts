/**
 * Database pull utilities
 *
 * Uses Kysely introspection to generate a ZenStack schema from a live database.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { sql } from "kysely";
import { createKyselyAdapter, type KyselyDialect } from "../sql/kysely-adapter.js";

export interface PullOptions {
  /** Database dialect */
  dialect: KyselyDialect;
  /** Database connection URL */
  connectionUrl?: string;
  /** SQLite database path (for SQLite dialect) */
  databasePath?: string;
  /** Output path for schema */
  outputPath: string;
  /** Write the schema to outputPath (default: true) */
  writeFile?: boolean;
}

export interface PullResult {
  outputPath: string;
  schema: string;
  tableCount: number;
}

const INTERNAL_TABLES = new Set([
  "_kysely_migration",
  "_kysely_migration_lock",
  "__drizzle_migrations",
  "sqlite_sequence",
]);

function isInternalTable(name: string): boolean {
  return INTERNAL_TABLES.has(name) || name.startsWith("sqlite_");
}

interface TableMetadata {
  name: string;
  columns: Array<{
    name: string;
    dataType: string;
    isNullable: boolean;
    isAutoIncrementing: boolean;
    hasDefaultValue: boolean;
  }>;
}

interface ForeignKeyInfo {
  constraintName: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface IndexInfo {
  name: string;
  table: string;
  columns: string[];
  isUnique: boolean;
}

interface PrimaryKeyInfo {
  table: string;
  columns: string[];
}

function pluralize(word: string): string {
  if (word.endsWith("s") || word.endsWith("x") || word.endsWith("ch") || word.endsWith("sh")) {
    return word + "es";
  }
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + "ies";
  }
  return word + "s";
}

function singularize(word: string): string {
  if (word.endsWith("ies")) {
    return word.slice(0, -3) + "y";
  }
  if (word.endsWith("es") && (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("ches") || word.endsWith("shes"))) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function toPascalCase(value: string): string {
  const parts = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.length > 0 ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : value;
}

function normalizeType(dataType: string): { type: string; isArray: boolean } {
  const lower = dataType.toLowerCase();
  const isArray = lower.endsWith("[]");
  const base = isArray ? lower.slice(0, -2) : lower;
  const normalized = base.replace(/\(.+\)/, "").trim();

  if (normalized.includes("uuid") || normalized.includes("citext")) return { type: "String", isArray };
  if (normalized.includes("jsonb")) return { type: "Json", isArray };
  if (normalized.includes("bigint")) return { type: "BigInt", isArray };
  if (normalized.includes("int")) return { type: "Int", isArray };
  if (normalized.includes("bool")) return { type: "Boolean", isArray };
  if (normalized.includes("date") || normalized.includes("time")) return { type: "DateTime", isArray };
  if (normalized.includes("json")) return { type: "Json", isArray };
  if (normalized.includes("blob") || normalized.includes("bytea") || normalized.includes("binary"))
    return { type: "Bytes", isArray };
  if (normalized.includes("decimal") || normalized.includes("numeric"))
    return { type: "Decimal", isArray };
  if (normalized.includes("real") || normalized.includes("double") || normalized.includes("float"))
    return { type: "Float", isArray };
  if (normalized.includes("char") || normalized.includes("text") || normalized.includes("uuid"))
    return { type: "String", isArray };

  return { type: "String", isArray };
}

function buildDatasourceBlock(dialect: KyselyDialect): string {
  const provider = dialect === "postgres" ? "postgresql" : dialect;
  return [
    "datasource db {",
    `  provider = \"${provider}\"`,
    "  url      = env(\"DATABASE_URL\")",
    "}",
    "",
    "generator client {",
    "  provider = \"prisma-client-js\"",
    "}",
    "",
  ].join("\n");
}

interface BuildModelOptions {
  table: TableMetadata;
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  primaryKeys: PrimaryKeyInfo[];
  allTables: Set<string>;
  columnDefaults: Map<string, string | null>;
}

function buildModelBlock(options: BuildModelOptions): string {
  const { table, foreignKeys, indexes, primaryKeys, allTables, columnDefaults } = options;
  const modelName = toPascalCase(table.name) || "Model";
  const fieldLines: string[] = [];

  // Get primary key columns for this table
  const tablePk = primaryKeys.find((pk) => pk.table === table.name);
  const pkColumns = new Set(tablePk?.columns ?? []);
  const isCompositePk = pkColumns.size > 1;

  // Group foreign keys by fromColumn for this table
  const fkByColumn = new Map<string, ForeignKeyInfo>();
  const incomingFks: ForeignKeyInfo[] = [];

  for (const fk of foreignKeys) {
    if (fk.fromTable === table.name) {
      fkByColumn.set(fk.fromColumn, fk);
    }
    if (fk.toTable === table.name) {
      incomingFks.push(fk);
    }
  }

  // Get unique columns from indexes (excluding PK columns)
  const uniqueColumns = new Set<string>();
  const compositeUniques: string[][] = [];
  for (const idx of indexes) {
    if (idx.table === table.name && idx.isUnique) {
      // Skip if this index matches the primary key
      const isPkIndex = idx.columns.length === pkColumns.size &&
        idx.columns.every((c) => pkColumns.has(c));
      if (isPkIndex) continue;

      if (idx.columns.length === 1) {
        uniqueColumns.add(idx.columns[0]);
      } else {
        compositeUniques.push(idx.columns);
      }
    }
  }

  const getDefaultExpr = (columnName: string) => columnDefaults.get(columnName);
  const buildDefaultAttribute = (defaultExpr: string | null, dataType: string): string | null => {
    if (!defaultExpr) return null;
    const normalized = defaultExpr.trim();
    if (!normalized || normalized.toLowerCase() === "null") return null;

    const lower = normalized.toLowerCase();
    if (lower.includes("nextval(")) return null;

    if (
      lower === "current_timestamp" ||
      lower === "current_timestamp()" ||
      lower === "now()" ||
      lower.includes("datetime('now") ||
      lower.includes("now()")
    ) {
      return "@default(now())";
    }

    if (lower.includes("uuid_generate_v4()") || lower.includes("gen_random_uuid()") || lower === "uuid()") {
      return "@default(uuid())";
    }

    if (lower === "true" || lower === "false") {
      return `@default(${lower})`;
    }

    if ((lower === "0" || lower === "1") && dataType.toLowerCase().includes("bool")) {
      return `@default(${lower === "1" ? "true" : "false"})`;
    }

    if (/^-?\d+(\.\d+)?$/.test(normalized)) {
      return `@default(${normalized})`;
    }

    if (
      (normalized.startsWith("'") && normalized.endsWith("'")) ||
      (normalized.startsWith("\"") && normalized.endsWith("\""))
    ) {
      const unquoted = normalized
        .slice(1, -1)
        .replace(/''/g, "'")
        .replace(/\\"/g, "\"");
      return `@default(${JSON.stringify(unquoted)})`;
    }

    return "@default(dbgenerated())";
  };

  const sortedColumns = [...table.columns].sort((a, b) => a.name.localeCompare(b.name));

  for (const column of sortedColumns) {
    const fieldName = toCamelCase(column.name) || column.name;
    const mapped = fieldName !== column.name;
    const { type, isArray } = normalizeType(column.dataType);
    const optional = column.isNullable ? "?" : "";
    const modifiers: string[] = [];

    const isPkColumn = pkColumns.has(column.name);

    // For single-column PK, add @id to the field
    if (isPkColumn && !isCompositePk) {
      modifiers.push("@id");
      if (column.isAutoIncrementing) {
        modifiers.push("@default(autoincrement())");
      }
    }

    // Add @unique for unique columns (but not PK columns)
    if (uniqueColumns.has(column.name) && !isPkColumn) {
      modifiers.push("@unique");
    }

    if (mapped) {
      modifiers.push(`@map("${column.name}")`);
    }

    if (column.hasDefaultValue && !modifiers.some((m) => m.includes("@default"))) {
      const attr = buildDefaultAttribute(getDefaultExpr(column.name), column.dataType);
      if (attr) {
        modifiers.push(attr);
      } else {
        modifiers.push("@default(dbgenerated())");
      }
    }

    const typeSuffix = isArray ? "[]" : "";
    const modifierText = modifiers.length > 0 ? ` ${modifiers.join(" ")}` : "";
    fieldLines.push(`  ${fieldName} ${type}${typeSuffix}${optional}${modifierText}`);
  }

  // Add relation fields for outgoing foreign keys
  for (const fk of fkByColumn.values()) {
    if (!allTables.has(fk.toTable)) continue;

    const relatedModel = toPascalCase(fk.toTable);
    const relationFieldName = toCamelCase(singularize(fk.toTable));
    const fkFieldName = toCamelCase(fk.fromColumn);

    // Find if the FK column is nullable
    const fkColumn = table.columns.find((c) => c.name === fk.fromColumn);
    const optional = fkColumn?.isNullable ? "?" : "";

    fieldLines.push(
      `  ${relationFieldName} ${relatedModel}${optional} @relation(fields: [${fkFieldName}], references: [${toCamelCase(fk.toColumn)}])`
    );
  }

  // Add reverse relation fields for incoming foreign keys
  const incomingByTable = new Map<string, ForeignKeyInfo[]>();
  for (const fk of incomingFks) {
    if (!allTables.has(fk.fromTable)) continue;
    const existing = incomingByTable.get(fk.fromTable) ?? [];
    existing.push(fk);
    incomingByTable.set(fk.fromTable, existing);
  }

  for (const [fromTable, fks] of incomingByTable) {
    const relatedModel = toPascalCase(fromTable);
    const relationFieldName = toCamelCase(pluralize(fromTable));

    // If there are multiple FKs from the same table, we need to name them
    if (fks.length > 1) {
      for (const fk of fks) {
        const suffix = toPascalCase(fk.fromColumn.replace(/Id$/, ""));
        fieldLines.push(`  ${relationFieldName}By${suffix} ${relatedModel}[]`);
      }
    } else {
      fieldLines.push(`  ${relationFieldName} ${relatedModel}[]`);
    }
  }

  const lines = [`model ${modelName} {`, ...fieldLines];

  // Add composite primary key
  if (isCompositePk && tablePk) {
    const fieldNames = tablePk.columns.map((c) => toCamelCase(c));
    lines.push(`  @@id([${fieldNames.join(", ")}])`);
  }

  // Add composite unique constraints
  for (const columns of compositeUniques) {
    const fieldNames = columns.map((c) => toCamelCase(c));
    lines.push(`  @@unique([${fieldNames.join(", ")}])`);
  }

  if (table.name !== modelName.toLowerCase()) {
    lines.push(`  @@map("${table.name}")`);
  }

  lines.push("}");

  return lines.join("\n");
}

async function extractForeignKeys(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  dialect: KyselyDialect
): Promise<ForeignKeyInfo[]> {
  const foreignKeys: ForeignKeyInfo[] = [];

  if (dialect === "sqlite") {
    // SQLite: query each table's foreign keys via PRAGMA
    const tables = await db.introspection.getTables({ withInternalKyselyTables: false });
    for (const table of tables) {
      if (table.isView || isInternalTable(table.name)) continue;
      const result = await sql<{
        id: number;
        table: string;
        from: string;
        to: string;
      }>`PRAGMA foreign_key_list(${sql.raw(`"${table.name}"`)})`.execute(db);
      for (const row of result.rows) {
        foreignKeys.push({
          constraintName: `fk_${table.name}_${row.from}`,
          fromTable: table.name,
          fromColumn: row.from,
          toTable: row.table,
          toColumn: row.to,
        });
      }
    }
  } else if (dialect === "postgres") {
    const result = await sql<{
      constraint_name: string;
      from_table: string;
      from_column: string;
      to_table: string;
      to_column: string;
    }>`
      SELECT
        tc.constraint_name,
        tc.table_name as from_table,
        kcu.column_name as from_column,
        ccu.table_name as to_table,
        ccu.column_name as to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `.execute(db);
    for (const row of result.rows) {
      foreignKeys.push({
        constraintName: row.constraint_name,
        fromTable: row.from_table,
        fromColumn: row.from_column,
        toTable: row.to_table,
        toColumn: row.to_column,
      });
    }
  } else if (dialect === "mysql") {
    const result = await sql<{
      CONSTRAINT_NAME: string;
      TABLE_NAME: string;
      COLUMN_NAME: string;
      REFERENCED_TABLE_NAME: string;
      REFERENCED_COLUMN_NAME: string;
    }>`
      SELECT
        CONSTRAINT_NAME,
        TABLE_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE REFERENCED_TABLE_NAME IS NOT NULL
        AND TABLE_SCHEMA = DATABASE()
    `.execute(db);
    for (const row of result.rows) {
      foreignKeys.push({
        constraintName: row.CONSTRAINT_NAME,
        fromTable: row.TABLE_NAME,
        fromColumn: row.COLUMN_NAME,
        toTable: row.REFERENCED_TABLE_NAME,
        toColumn: row.REFERENCED_COLUMN_NAME,
      });
    }
  }

  return foreignKeys;
}

async function extractIndexes(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  dialect: KyselyDialect,
  tableNames: string[]
): Promise<IndexInfo[]> {
  const indexes: IndexInfo[] = [];

  if (dialect === "sqlite") {
    for (const tableName of tableNames) {
      const indexList = await sql<{ name: string; unique: number }>`PRAGMA index_list(${sql.raw(`"${tableName}"`)})`.execute(db);
      for (const idx of indexList.rows) {
        // Skip internal sqlite indexes, but allow sqlite_autoindex_ which are auto-created for UNIQUE constraints
        if (idx.name.startsWith("sqlite_") && !idx.name.startsWith("sqlite_autoindex_")) continue;
        const indexInfo = await sql<{ name: string }>`PRAGMA index_info(${sql.raw(`"${idx.name}"`)})`.execute(db);
        indexes.push({
          name: idx.name,
          table: tableName,
          columns: indexInfo.rows.map((r) => r.name),
          isUnique: idx.unique === 1,
        });
      }
    }
  } else if (dialect === "postgres") {
    const result = await sql<{
      indexname: string;
      tablename: string;
      indexdef: string;
    }>`
      SELECT indexname, tablename, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
    `.execute(db);
    for (const row of result.rows) {
      const isUnique = row.indexdef.toUpperCase().includes("UNIQUE");
      const colMatch = row.indexdef.match(/\(([^)]+)\)/);
      const columns = colMatch
        ? colMatch[1].split(",").map((c) => c.trim().replace(/"/g, ""))
        : [];
      indexes.push({
        name: row.indexname,
        table: row.tablename,
        columns,
        isUnique,
      });
    }
  } else if (dialect === "mysql") {
    for (const tableName of tableNames) {
      const result = await sql<{
        Key_name: string;
        Column_name: string;
        Non_unique: number;
      }>`SHOW INDEX FROM ${sql.raw(`\`${tableName}\``)}`.execute(db);
      const byName = new Map<string, { columns: string[]; isUnique: boolean }>();
      for (const row of result.rows) {
        if (!byName.has(row.Key_name)) {
          byName.set(row.Key_name, { columns: [], isUnique: row.Non_unique === 0 });
        }
        byName.get(row.Key_name)!.columns.push(row.Column_name);
      }
      for (const [name, info] of byName) {
        indexes.push({
          name,
          table: tableName,
          columns: info.columns,
          isUnique: info.isUnique,
        });
      }
    }
  }

  return indexes;
}

async function extractPrimaryKeys(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  dialect: KyselyDialect,
  tableNames: string[]
): Promise<PrimaryKeyInfo[]> {
  const primaryKeys: PrimaryKeyInfo[] = [];

  if (dialect === "sqlite") {
    for (const tableName of tableNames) {
      const tableInfo = await sql<{
        name: string;
        pk: number;
      }>`PRAGMA table_info(${sql.raw(`"${tableName}"`)})`.execute(db);
      const pkColumns = tableInfo.rows
        .filter((row) => row.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((row) => row.name);
      if (pkColumns.length > 0) {
        primaryKeys.push({ table: tableName, columns: pkColumns });
      }
    }
  } else if (dialect === "postgres") {
    const result = await sql<{
      table_name: string;
      column_name: string;
      ordinal_position: number;
    }>`
      SELECT
        tc.table_name,
        kcu.column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.ordinal_position
    `.execute(db);

    const byTable = new Map<string, string[]>();
    for (const row of result.rows) {
      if (!byTable.has(row.table_name)) {
        byTable.set(row.table_name, []);
      }
      byTable.get(row.table_name)!.push(row.column_name);
    }
    for (const [table, columns] of byTable) {
      primaryKeys.push({ table, columns });
    }
  } else if (dialect === "mysql") {
    for (const tableName of tableNames) {
      const result = await sql<{
        Column_name: string;
        Seq_in_index: number;
      }>`SHOW INDEX FROM ${sql.raw(`\`${tableName}\``)} WHERE Key_name = 'PRIMARY'`.execute(db);
      const columns = result.rows
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
        .map((row) => row.Column_name);
      if (columns.length > 0) {
        primaryKeys.push({ table: tableName, columns });
      }
    }
  }

  return primaryKeys;
}

async function extractColumnDefaults(
  db: Awaited<ReturnType<typeof createKyselyAdapter>>["db"],
  dialect: KyselyDialect,
  tableNames: string[]
): Promise<Map<string, Map<string, string | null>>> {
  const defaultsByTable = new Map<string, Map<string, string | null>>();
  const tableSet = new Set(tableNames);

  const setDefault = (table: string, column: string, value: string | null) => {
    if (!defaultsByTable.has(table)) {
      defaultsByTable.set(table, new Map());
    }
    defaultsByTable.get(table)!.set(column, value);
  };

  if (dialect === "sqlite") {
    for (const tableName of tableNames) {
      const result = await sql<{ name: string; dflt_value: string | null }>`
        PRAGMA table_info(${sql.raw(`"${tableName}"`)})
      `.execute(db);
      for (const row of result.rows) {
        setDefault(tableName, row.name, row.dflt_value);
      }
    }
  } else if (dialect === "postgres") {
    const result = await sql<{ table_name: string; column_name: string; column_default: string | null }>`
      SELECT table_name, column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `.execute(db);
    for (const row of result.rows) {
      if (!tableSet.has(row.table_name)) continue;
      setDefault(row.table_name, row.column_name, row.column_default);
    }
  } else if (dialect === "mysql") {
    const result = await sql<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_DEFAULT: string | null }>`
      SELECT TABLE_NAME, COLUMN_NAME, COLUMN_DEFAULT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
    `.execute(db);
    for (const row of result.rows) {
      if (!tableSet.has(row.TABLE_NAME)) continue;
      setDefault(row.TABLE_NAME, row.COLUMN_NAME, row.COLUMN_DEFAULT);
    }
  }

  return defaultsByTable;
}

export async function pullSchema(options: PullOptions): Promise<PullResult> {
  const { db, destroy } = await createKyselyAdapter({
    dialect: options.dialect,
    connectionUrl: options.connectionUrl,
    databasePath: options.databasePath,
  });

  try {
    const tables = await db.introspection.getTables({ withInternalKyselyTables: false });
    const filtered = tables.filter((table) => !table.isView && !isInternalTable(table.name));
    const tableNames = filtered.map((t) => t.name);
    const allTables = new Set(tableNames);

    const foreignKeys = await extractForeignKeys(db, options.dialect);
    const indexes = await extractIndexes(db, options.dialect, tableNames);
    const primaryKeys = await extractPrimaryKeys(db, options.dialect, tableNames);
    const columnDefaultsByTable = await extractColumnDefaults(db, options.dialect, tableNames);

    const blocks = filtered.map((table) =>
      buildModelBlock({
        table,
        foreignKeys,
        indexes,
        primaryKeys,
        allTables,
        columnDefaults: columnDefaultsByTable.get(table.name) ?? new Map(),
      })
    );

    const schema = [buildDatasourceBlock(options.dialect), ...blocks].join("\n\n");

    if (options.writeFile !== false) {
      await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
      await fs.writeFile(options.outputPath, schema.trimEnd() + "\n", "utf-8");
    }

    return {
      outputPath: options.outputPath,
      schema,
      tableCount: filtered.length,
    };
  } finally {
    await destroy();
  }
}

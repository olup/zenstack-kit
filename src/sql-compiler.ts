/**
 * SQL Compiler - Generates raw SQL from schema operations using Kysely's compile()
 *
 * Uses Kysely with DummyDriver to compile schema operations to dialect-specific SQL
 * without requiring a database connection.
 */

import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  sql,
} from "kysely";
import type { KyselyDialect } from "./kysely-adapter.js";
import type { SchemaTable, SchemaColumn } from "./schema-snapshot.js";

/**
 * Create a Kysely instance configured for SQL compilation only (no actual DB connection)
 */
function createCompilerDb(dialect: KyselyDialect): Kysely<any> {
  if (dialect === "sqlite") {
    return new Kysely({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new SqliteIntrospector(db),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    });
  } else if (dialect === "postgres") {
    return new Kysely({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  } else {
    return new Kysely({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new MysqlIntrospector(db),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
    });
  }
}

export interface SqlMigration {
  up: string[];
  down: string[];
}

export interface CompileSqlOptions {
  dialect: KyselyDialect;
}

/**
 * Compile a CREATE TABLE statement to SQL
 */
export function compileCreateTable(
  model: SchemaTable,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  let builder = db.schema.createTable(model.name);

  for (const column of model.columns) {
    const columnType = mapColumnType(column.type, options.dialect);
    builder = builder.addColumn(column.name, sql.raw(columnType) as any, (cb) => {
      if (column.notNull) {
        cb = cb.notNull();
      }
      if (column.default !== undefined) {
        cb = cb.defaultTo(sql.raw(formatDefault(column.default, options.dialect)));
      }
      return cb;
    });
  }

  // Add primary key constraint
  if (model.primaryKey) {
    builder = builder.addPrimaryKeyConstraint(
      model.primaryKey.name,
      model.primaryKey.columns as any
    );
  }

  // Add unique constraints
  for (const unique of model.uniqueConstraints) {
    builder = builder.addUniqueConstraint(unique.name, unique.columns as any);
  }

  // Add foreign key constraints
  for (const fk of model.foreignKeys) {
    builder = builder.addForeignKeyConstraint(
      fk.name,
      fk.columns as any,
      fk.referencedTable,
      fk.referencedColumns as any
    );
  }

  return builder.compile().sql + ";";
}

/**
 * Compile a DROP TABLE statement to SQL
 */
export function compileDropTable(
  tableName: string,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return db.schema.dropTable(tableName).ifExists().compile().sql + ";";
}

/**
 * Compile an ADD COLUMN statement to SQL
 */
export function compileAddColumn(
  tableName: string,
  column: SchemaColumn,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  const columnType = mapColumnType(column.type, options.dialect);

  return (
    db.schema
      .alterTable(tableName)
      .addColumn(column.name, sql.raw(columnType) as any, (cb) => {
        if (column.notNull) {
          cb = cb.notNull();
        }
        if (column.default !== undefined) {
          cb = cb.defaultTo(sql.raw(formatDefault(column.default, options.dialect)));
        }
        return cb;
      })
      .compile().sql + ";"
  );
}

/**
 * Compile a DROP COLUMN statement to SQL
 */
export function compileDropColumn(
  tableName: string,
  columnName: string,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return db.schema.alterTable(tableName).dropColumn(columnName).compile().sql + ";";
}

/**
 * Compile a RENAME TABLE statement to SQL
 */
export function compileRenameTable(
  fromName: string,
  toName: string,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return db.schema.alterTable(fromName).renameTo(toName).compile().sql + ";";
}

/**
 * Compile a RENAME COLUMN statement to SQL
 */
export function compileRenameColumn(
  tableName: string,
  fromName: string,
  toName: string,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return (
    db.schema.alterTable(tableName).renameColumn(fromName, toName).compile().sql + ";"
  );
}

/**
 * Compile a CREATE INDEX statement to SQL
 */
export function compileCreateIndex(
  tableName: string,
  indexName: string,
  columns: string[],
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  let builder = db.schema.createIndex(indexName).on(tableName);
  for (const col of columns) {
    builder = builder.column(col);
  }
  return builder.compile().sql + ";";
}

/**
 * Compile a DROP INDEX statement to SQL
 */
export function compileDropIndex(
  indexName: string,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return db.schema.dropIndex(indexName).compile().sql + ";";
}

/**
 * Compile an ADD CONSTRAINT (unique) statement to SQL
 */
export function compileAddUniqueConstraint(
  tableName: string,
  constraintName: string,
  columns: string[],
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return (
    db.schema
      .alterTable(tableName)
      .addUniqueConstraint(constraintName, columns as any)
      .compile().sql + ";"
  );
}

/**
 * Compile a DROP CONSTRAINT statement to SQL
 */
export function compileDropConstraint(
  tableName: string,
  constraintName: string,
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return (
    db.schema.alterTable(tableName).dropConstraint(constraintName).compile().sql + ";"
  );
}

/**
 * Compile an ADD FOREIGN KEY CONSTRAINT statement to SQL
 */
export function compileAddForeignKeyConstraint(
  tableName: string,
  constraintName: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return (
    db.schema
      .alterTable(tableName)
      .addForeignKeyConstraint(
        constraintName,
        columns as any,
        referencedTable,
        referencedColumns as any
      )
      .compile().sql + ";"
  );
}

/**
 * Compile an ADD PRIMARY KEY CONSTRAINT statement to SQL
 */
export function compileAddPrimaryKeyConstraint(
  tableName: string,
  constraintName: string,
  columns: string[],
  options: CompileSqlOptions
): string {
  const db = createCompilerDb(options.dialect);
  return (
    db.schema
      .alterTable(tableName)
      .addPrimaryKeyConstraint(constraintName, columns as any)
      .compile().sql + ";"
  );
}

/**
 * Compile ALTER COLUMN statements for type/nullability/default changes
 */
export function compileAlterColumn(
  tableName: string,
  columnName: string,
  changes: {
    setType?: string;
    setNotNull?: boolean;
    dropNotNull?: boolean;
    setDefault?: string | number | boolean;
    dropDefault?: boolean;
  },
  options: CompileSqlOptions
): string[] {
  const db = createCompilerDb(options.dialect);
  const statements: string[] = [];

  if (changes.setType) {
    const columnType = mapColumnType(changes.setType, options.dialect);
    statements.push(
      db.schema
        .alterTable(tableName)
        .alterColumn(columnName, (ac) => ac.setDataType(columnType as any))
        .compile().sql + ";"
    );
  }

  if (changes.setNotNull) {
    statements.push(
      db.schema
        .alterTable(tableName)
        .alterColumn(columnName, (ac) => ac.setNotNull())
        .compile().sql + ";"
    );
  }

  if (changes.dropNotNull) {
    statements.push(
      db.schema
        .alterTable(tableName)
        .alterColumn(columnName, (ac) => ac.dropNotNull())
        .compile().sql + ";"
    );
  }

  if (changes.setDefault !== undefined) {
    statements.push(
      db.schema
        .alterTable(tableName)
        .alterColumn(columnName, (ac) =>
          ac.setDefault(sql.raw(formatDefault(changes.setDefault!, options.dialect)))
        )
        .compile().sql + ";"
    );
  }

  if (changes.dropDefault) {
    statements.push(
      db.schema
        .alterTable(tableName)
        .alterColumn(columnName, (ac) => ac.dropDefault())
        .compile().sql + ";"
    );
  }

  return statements;
}

/**
 * Map our internal type names to dialect-specific SQL types
 */
function mapColumnType(type: string, dialect: KyselyDialect): string {
  // Most types are already SQL types from our snapshot, just return as-is
  // The Kysely compiler will handle dialect-specific adjustments
  return type;
}

/**
 * Format a default value for SQL
 */
function formatDefault(value: string | number | boolean, dialect: KyselyDialect): string {
  if (typeof value === "string") {
    // Check if it's a function call like now() or autoincrement()
    if (/^\w+\([^)]*\)$/.test(value)) {
      return value;
    }
    // Escape string values
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "boolean") {
    if (dialect === "sqlite") {
      return value ? "1" : "0";
    }
    return value ? "true" : "false";
  }
  return String(value);
}

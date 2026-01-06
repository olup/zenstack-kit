/**
 * Migration generation and management
 *
 * Creates and manages database migrations based on ZenStack schema changes
 * using AST-based diffs and Kysely schema builder operations.
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  createSnapshot,
  type SchemaSnapshot,
  type SchemaTable,
  type SchemaColumn,
  type SchemaSnapshotFile,
  generateSchemaSnapshot,
} from "./schema-snapshot.js";

export interface MigrationOptions {
  /** Migration name */
  name?: string;
  /** Path to ZenStack schema file */
  schemaPath: string;
  /** Output directory for migration files */
  outputPath: string;
  /** Optional snapshot file override */
  snapshotPath?: string;
  /** Table rename mappings */
  renameTables?: Array<{ from: string; to: string }>;
  /** Column rename mappings */
  renameColumns?: Array<{ table: string; from: string; to: string }>;
}

export interface Migration {
  /** Migration filename */
  filename: string;
  /** Kysely schema builder up migration */
  up: string;
  /** Kysely schema builder down migration */
  down: string;
  /** Timestamp */
  timestamp: number;
}

interface FieldChange {
  model: SchemaTable;
  tableName: string;
  columnName: string;
  previous: SchemaColumn;
  current: SchemaColumn;
  changes: {
    typeChanged: boolean;
    requiredChanged: boolean;
    defaultChanged: boolean;
    listChanged: boolean;
  };
}

interface DiffResult {
  addedModels: SchemaTable[];
  removedModels: SchemaTable[];
  addedFields: Array<{ model: SchemaTable; tableName: string; field: SchemaColumn; columnName: string }>;
  removedFields: Array<{ model: SchemaTable; tableName: string; field: SchemaColumn; columnName: string }>;
  alteredFields: FieldChange[];
  renamedTables: Array<{ from: string; to: string }>;
  renamedColumns: Array<{ tableName: string; from: string; to: string }>;
  addedUniqueConstraints: Array<{ tableName: string; constraint: { name: string; columns: string[] } }>;
  removedUniqueConstraints: Array<{ tableName: string; constraint: { name: string; columns: string[] } }>;
  addedIndexes: Array<{ tableName: string; index: { name: string; columns: string[] } }>;
  removedIndexes: Array<{ tableName: string; index: { name: string; columns: string[] } }>;
  addedForeignKeys: Array<{
    tableName: string;
    foreignKey: { name: string; columns: string[]; referencedTable: string; referencedColumns: string[] };
  }>;
  removedForeignKeys: Array<{
    tableName: string;
    foreignKey: { name: string; columns: string[]; referencedTable: string; referencedColumns: string[] };
  }>;
  primaryKeyChanges: Array<{
    tableName: string;
    previous?: { name: string; columns: string[] };
    current?: { name: string; columns: string[] };
  }>;
}

interface MigrationPlan {
  upStatements: string[];
  downStatements: string[];
}

function getSnapshotPaths(outputPath: string, snapshotPath?: string) {
  if (snapshotPath) {
    return {
      metaDir: path.dirname(snapshotPath),
      snapshotPath,
    };
  }

  const metaDir = path.join(outputPath, "meta");
  return {
    metaDir,
    snapshotPath: path.join(metaDir, "_snapshot.json"),
  };
}

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

async function writeSnapshot(snapshotPath: string, schema: SchemaSnapshot): Promise<void> {
  const snapshot = createSnapshot(schema);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
}

function buildColumnBuilder(field: SchemaColumn): string | null {
  const parts: string[] = [];

  if (field.notNull) {
    parts.push("notNull()");
  }

  if (field.default !== undefined) {
    parts.push(`defaultTo(${formatLiteral(field.default)})`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `(col) => col.${parts.join(".")}`;
}

function formatLiteral(value: string | number | boolean): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function buildCreateTable(model: SchemaTable): string {
  const tableName = model.name;
  const columns = model.columns.map((field) => {
    const columnName = field.name;
    const columnType = field.type;
    const builder = buildColumnBuilder(field);

    if (builder) {
      return `.addColumn('${columnName}', '${columnType}', ${builder})`;
    }

    return `.addColumn('${columnName}', '${columnType}')`;
  });

  const constraints: string[] = [];

  if (model.primaryKey) {
    constraints.push(
      `.addPrimaryKeyConstraint('${model.primaryKey.name}', ${JSON.stringify(model.primaryKey.columns)})`,
    );
  }

  for (const unique of model.uniqueConstraints) {
    constraints.push(
      `.addUniqueConstraint('${unique.name}', ${JSON.stringify(unique.columns)})`,
    );
  }

  for (const foreignKey of model.foreignKeys) {
    constraints.push(
      `.addForeignKeyConstraint('${foreignKey.name}', ${JSON.stringify(
        foreignKey.columns,
      )}, '${foreignKey.referencedTable}', ${JSON.stringify(foreignKey.referencedColumns)})`,
    );
  }

  const statements: string[] = [
    `await db.schema.createTable('${tableName}')`,
    ...columns,
    ...constraints,
    ".execute();",
  ];

  for (const index of model.indexes) {
    statements.push(buildCreateIndex(tableName, index.name, index.columns));
  }

  return statements.join("\n\n");
}

function buildDropTable(model: SchemaTable): string {
  const tableName = model.name;
  return `await db.schema.dropTable('${tableName}').ifExists().execute();`;
}

function buildAddColumn(model: SchemaTable, field: SchemaColumn): string {
  const tableName = model.name;
  const columnName = field.name;
  const columnType = field.type;
  const builder = buildColumnBuilder(field);

  if (builder) {
    return [
      `await db.schema.alterTable('${tableName}')`,
      `.addColumn('${columnName}', '${columnType}', ${builder})`,
      ".execute();",
    ].join("\n");
  }

  return [
    `await db.schema.alterTable('${tableName}')`,
    `.addColumn('${columnName}', '${columnType}')`,
    ".execute();",
  ].join("\n");
}

function buildDropColumn(model: SchemaTable, field: SchemaColumn): string {
  const tableName = model.name;
  const columnName = field.name;
  return `await db.schema.alterTable('${tableName}').dropColumn('${columnName}').execute();`;
}

function buildAddPrimaryKeyConstraint(tableName: string, name: string, columns: string[]): string {
  return [
    `await db.schema.alterTable('${tableName}')`,
    `.addPrimaryKeyConstraint('${name}', ${JSON.stringify(columns)})`,
    ".execute();",
  ].join("\n");
}

function buildAddUniqueConstraint(tableName: string, name: string, columns: string[]): string {
  return [
    `await db.schema.alterTable('${tableName}')`,
    `.addUniqueConstraint('${name}', ${JSON.stringify(columns)})`,
    ".execute();",
  ].join("\n");
}

function buildDropConstraint(tableName: string, name: string): string {
  return `await db.schema.alterTable('${tableName}').dropConstraint('${name}').execute();`;
}

function buildCreateIndex(tableName: string, name: string, columns: string[]): string {
  const statement = [
    `await db.schema.createIndex('${name}')`,
    `.on('${tableName}')`,
    ...columns.map((column) => `.column('${column}')`),
    ".execute();",
  ];

  return statement.join("\n");
}

function buildDropIndex(name: string): string {
  return `await db.schema.dropIndex('${name}').execute();`;
}

function buildAddForeignKeyConstraint(
  tableName: string,
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
): string {
  return [
    `await db.schema.alterTable('${tableName}')`,
    `.addForeignKeyConstraint('${name}', ${JSON.stringify(columns)}, '${referencedTable}', ${JSON.stringify(referencedColumns)})`,
    ".execute();",
  ].join("\n");
}

function buildAlterColumnChanges(change: FieldChange): { up: string[]; down: string[] } {
  const upStatements: string[] = [];
  const downStatements: string[] = [];
  const tableName = change.tableName;
  const columnName = change.columnName;

  if (change.changes.typeChanged || change.changes.listChanged) {
    const upType = change.current.type;
    const downType = change.previous.type;

    upStatements.push(
      `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.setDataType('${upType}')).execute();`,
    );
    downStatements.push(
      `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.setDataType('${downType}')).execute();`,
    );
  }

  if (change.changes.requiredChanged) {
    if (change.current.notNull) {
      upStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.setNotNull()).execute();`,
      );
      downStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.dropNotNull()).execute();`,
      );
    } else {
      upStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.dropNotNull()).execute();`,
      );
      downStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.setNotNull()).execute();`,
      );
    }
  }

  if (change.changes.defaultChanged) {
    if (change.current.default !== undefined) {
      upStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.setDefault(${formatLiteral(change.current.default)})).execute();`,
      );
    } else {
      upStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.dropDefault()).execute();`,
      );
    }

    if (change.previous.default !== undefined) {
      downStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.setDefault(${formatLiteral(change.previous.default)})).execute();`,
      );
    } else {
      downStatements.push(
        `await db.schema.alterTable('${tableName}').alterColumn('${columnName}', (ac) => ac.dropDefault()).execute();`,
      );
    }
  }

  return { up: upStatements, down: downStatements };
}

function diffSchemas(previous: SchemaSnapshot | null, current: SchemaSnapshot): DiffResult {
  const previousModels = new Map<string, SchemaTable>();
  const currentModels = new Map<string, SchemaTable>();

  previous?.tables.forEach((model) => previousModels.set(model.name, model));
  current.tables.forEach((model) => currentModels.set(model.name, model));

  const addedModels: SchemaTable[] = [];
  const removedModels: SchemaTable[] = [];
  const addedFields: DiffResult["addedFields"] = [];
  const removedFields: DiffResult["removedFields"] = [];
  const alteredFields: DiffResult["alteredFields"] = [];
  const addedUniqueConstraints: DiffResult["addedUniqueConstraints"] = [];
  const removedUniqueConstraints: DiffResult["removedUniqueConstraints"] = [];
  const addedIndexes: DiffResult["addedIndexes"] = [];
  const removedIndexes: DiffResult["removedIndexes"] = [];
  const addedForeignKeys: DiffResult["addedForeignKeys"] = [];
  const removedForeignKeys: DiffResult["removedForeignKeys"] = [];
  const primaryKeyChanges: DiffResult["primaryKeyChanges"] = [];
  const renamedTables: DiffResult["renamedTables"] = [];
  const renamedColumns: DiffResult["renamedColumns"] = [];

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

  for (const [tableName, currentModel] of currentModels.entries()) {
    const previousModel = previousModels.get(tableName);
    if (!previousModel) {
      continue;
    }

    const modelDiff = diffModelChanges(previousModel, currentModel, tableName);
    addedFields.push(...modelDiff.addedFields);
    removedFields.push(...modelDiff.removedFields);
    alteredFields.push(...modelDiff.alteredFields);
    addedUniqueConstraints.push(...modelDiff.addedUniqueConstraints);
    removedUniqueConstraints.push(...modelDiff.removedUniqueConstraints);
    addedIndexes.push(...modelDiff.addedIndexes);
    removedIndexes.push(...modelDiff.removedIndexes);
    addedForeignKeys.push(...modelDiff.addedForeignKeys);
    removedForeignKeys.push(...modelDiff.removedForeignKeys);
    primaryKeyChanges.push(...modelDiff.primaryKeyChanges);
  }

  return {
    addedModels,
    removedModels,
    addedFields,
    removedFields,
    alteredFields,
    renamedTables,
    renamedColumns,
    addedUniqueConstraints,
    removedUniqueConstraints,
    addedIndexes,
    removedIndexes,
    addedForeignKeys,
    removedForeignKeys,
    primaryKeyChanges,
  };
}

function diffModelChanges(
  previousModel: SchemaTable,
  currentModel: SchemaTable,
  tableName: string,
): Omit<DiffResult, "addedModels" | "removedModels" | "renamedTables" | "renamedColumns"> {
  const addedFields: DiffResult["addedFields"] = [];
  const removedFields: DiffResult["removedFields"] = [];
  const alteredFields: DiffResult["alteredFields"] = [];
  const addedUniqueConstraints: DiffResult["addedUniqueConstraints"] = [];
  const removedUniqueConstraints: DiffResult["removedUniqueConstraints"] = [];
  const addedIndexes: DiffResult["addedIndexes"] = [];
  const removedIndexes: DiffResult["removedIndexes"] = [];
  const addedForeignKeys: DiffResult["addedForeignKeys"] = [];
  const removedForeignKeys: DiffResult["removedForeignKeys"] = [];
  const primaryKeyChanges: DiffResult["primaryKeyChanges"] = [];

  const previousFields = new Map<string, SchemaColumn>();
  const currentFields = new Map<string, SchemaColumn>();

  previousModel.columns.forEach((field) => previousFields.set(field.name, field));
  currentModel.columns.forEach((field) => currentFields.set(field.name, field));

  for (const [columnName, field] of currentFields.entries()) {
    if (!previousFields.has(columnName)) {
      addedFields.push({ model: currentModel, tableName, field, columnName });
    }
  }

  for (const [columnName, field] of previousFields.entries()) {
    if (!currentFields.has(columnName)) {
      removedFields.push({ model: previousModel, tableName, field, columnName });
    }
  }

  for (const [columnName, currentField] of currentFields.entries()) {
    const previousField = previousFields.get(columnName);
    if (!previousField) {
      continue;
    }

    const typeChanged = previousField.type !== currentField.type;
    const requiredChanged = previousField.notNull !== currentField.notNull;
    const defaultChanged = previousField.default !== currentField.default;
    const listChanged = previousField.isArray !== currentField.isArray;

    if (typeChanged || requiredChanged || defaultChanged || listChanged) {
      alteredFields.push({
        model: currentModel,
        tableName,
        columnName,
        previous: previousField,
        current: currentField,
        changes: {
          typeChanged,
          requiredChanged,
          defaultChanged,
          listChanged,
        },
      });
    }
  }

  const previousPk = previousModel.primaryKey;
  const currentPk = currentModel.primaryKey;
  const pkEqual =
    (previousPk?.name ?? "") === (currentPk?.name ?? "") &&
    JSON.stringify(previousPk?.columns ?? []) === JSON.stringify(currentPk?.columns ?? []);

  if (!pkEqual) {
    primaryKeyChanges.push({
      tableName,
      previous: previousPk,
      current: currentPk,
    });
  }

  const previousUniqueMap = new Map(
    previousModel.uniqueConstraints.map((constraint) => [constraint.name, constraint]),
  );
  const currentUniqueMap = new Map(
    currentModel.uniqueConstraints.map((constraint) => [constraint.name, constraint]),
  );

  for (const [name, constraint] of currentUniqueMap.entries()) {
    if (!previousUniqueMap.has(name)) {
      addedUniqueConstraints.push({ tableName, constraint });
    }
  }

  for (const [name, constraint] of previousUniqueMap.entries()) {
    if (!currentUniqueMap.has(name)) {
      removedUniqueConstraints.push({ tableName, constraint });
    }
  }

  const previousIndexMap = new Map(
    previousModel.indexes.map((index) => [index.name, index]),
  );
  const currentIndexMap = new Map(
    currentModel.indexes.map((index) => [index.name, index]),
  );

  for (const [name, index] of currentIndexMap.entries()) {
    if (!previousIndexMap.has(name)) {
      addedIndexes.push({ tableName, index });
    }
  }

  for (const [name, index] of previousIndexMap.entries()) {
    if (!currentIndexMap.has(name)) {
      removedIndexes.push({ tableName, index });
    }
  }

  const previousFkMap = new Map(
    previousModel.foreignKeys.map((foreignKey) => [foreignKey.name, foreignKey]),
  );
  const currentFkMap = new Map(
    currentModel.foreignKeys.map((foreignKey) => [foreignKey.name, foreignKey]),
  );

  for (const [name, foreignKey] of currentFkMap.entries()) {
    if (!previousFkMap.has(name)) {
      addedForeignKeys.push({ tableName, foreignKey });
    }
  }

  for (const [name, foreignKey] of previousFkMap.entries()) {
    if (!currentFkMap.has(name)) {
      removedForeignKeys.push({ tableName, foreignKey });
    }
  }

  return {
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
  };
}

function applyRenameMappings(
  diff: DiffResult,
  renameTables: Array<{ from: string; to: string }> = [],
  renameColumns: Array<{ table: string; from: string; to: string }> = [],
): DiffResult {
  const removedModels = [...diff.removedModels];
  const addedModels = [...diff.addedModels];
  const removedFields = [...diff.removedFields];
  const addedFields = [...diff.addedFields];
  const alteredFields = [...diff.alteredFields];
  const addedUniqueConstraints = [...diff.addedUniqueConstraints];
  const removedUniqueConstraints = [...diff.removedUniqueConstraints];
  const addedIndexes = [...diff.addedIndexes];
  const removedIndexes = [...diff.removedIndexes];
  const addedForeignKeys = [...diff.addedForeignKeys];
  const removedForeignKeys = [...diff.removedForeignKeys];
  const primaryKeyChanges = [...diff.primaryKeyChanges];
  const renamedTables: DiffResult["renamedTables"] = [];
  const renamedColumns: DiffResult["renamedColumns"] = [];
  const renamedTableMap = new Map<string, string>();

  renameTables.forEach((mapping) => {
    const fromIndex = removedModels.findIndex((model) => model.name === mapping.from);
    const toIndex = addedModels.findIndex((model) => model.name === mapping.to);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    const previousModel = removedModels[fromIndex];
    const currentModel = addedModels[toIndex];

    removedModels.splice(fromIndex, 1);
    addedModels.splice(toIndex, 1);
    renamedTables.push({ from: mapping.from, to: mapping.to });
    renamedTableMap.set(mapping.from, mapping.to);

    const modelDiff = diffModelChanges(previousModel, currentModel, mapping.to);
    addedFields.push(...modelDiff.addedFields);
    removedFields.push(...modelDiff.removedFields);
    alteredFields.push(...modelDiff.alteredFields);
    addedUniqueConstraints.push(...modelDiff.addedUniqueConstraints);
    removedUniqueConstraints.push(...modelDiff.removedUniqueConstraints);
    addedIndexes.push(...modelDiff.addedIndexes);
    removedIndexes.push(...modelDiff.removedIndexes);
    addedForeignKeys.push(...modelDiff.addedForeignKeys);
    removedForeignKeys.push(...modelDiff.removedForeignKeys);
    primaryKeyChanges.push(...modelDiff.primaryKeyChanges);
  });

  if (renamedTableMap.size > 0) {
    removedFields.forEach((entry) => {
      const mapped = renamedTableMap.get(entry.tableName);
      if (mapped) {
        entry.tableName = mapped;
      }
    });
  }

  const remapTableName = (tableName: string) => renamedTableMap.get(tableName) ?? tableName;
  const remapTableEntries = <T extends { tableName: string }>(items: T[]) =>
    items.map((item) => ({ ...item, tableName: remapTableName(item.tableName) }));

  renameColumns.forEach((mapping) => {
    const fromIndex = removedFields.findIndex(
      (entry) => entry.tableName === mapping.table && entry.columnName === mapping.from,
    );
    const toIndex = addedFields.findIndex(
      (entry) => entry.tableName === mapping.table && entry.columnName === mapping.to,
    );

    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    removedFields.splice(fromIndex, 1);
    addedFields.splice(toIndex, 1);
    renamedColumns.push({ tableName: mapping.table, from: mapping.from, to: mapping.to });
  });

  return {
    ...diff,
    removedModels,
    addedModels,
    removedFields,
    addedFields,
    alteredFields,
    renamedTables,
    renamedColumns,
    addedUniqueConstraints: remapTableEntries(addedUniqueConstraints),
    removedUniqueConstraints: remapTableEntries(removedUniqueConstraints),
    addedIndexes: remapTableEntries(addedIndexes),
    removedIndexes: remapTableEntries(removedIndexes),
    addedForeignKeys: remapTableEntries(addedForeignKeys),
    removedForeignKeys: remapTableEntries(removedForeignKeys),
    primaryKeyChanges: remapTableEntries(primaryKeyChanges),
  };
}

function buildMigrationPlan(diff: DiffResult): MigrationPlan {
  const upStatements: string[] = [];
  const downStatements: string[] = [];

  diff.renamedTables.forEach((rename) => {
    upStatements.push(
      `await db.schema.alterTable('${rename.from}').renameTo('${rename.to}').execute();`,
    );
    downStatements.unshift(
      `await db.schema.alterTable('${rename.to}').renameTo('${rename.from}').execute();`,
    );
  });

  diff.renamedColumns.forEach((rename) => {
    upStatements.push(
      `await db.schema.alterTable('${rename.tableName}').renameColumn('${rename.from}', '${rename.to}').execute();`,
    );
    downStatements.unshift(
      `await db.schema.alterTable('${rename.tableName}').renameColumn('${rename.to}', '${rename.from}').execute();`,
    );
  });

  diff.addedModels.forEach((model) => {
    upStatements.push(buildCreateTable(model));
    downStatements.unshift(buildDropTable(model));
  });

  diff.removedModels.forEach((model) => {
    upStatements.push(buildDropTable(model));
    downStatements.unshift(buildCreateTable(model));
  });

  diff.primaryKeyChanges.forEach((change) => {
    if (change.previous) {
      upStatements.push(buildDropConstraint(change.tableName, change.previous.name));
      downStatements.unshift(buildAddPrimaryKeyConstraint(change.tableName, change.previous.name, change.previous.columns));
    }
  });

  diff.removedForeignKeys.forEach(({ tableName, foreignKey }) => {
    upStatements.push(buildDropConstraint(tableName, foreignKey.name));
    downStatements.unshift(
      buildAddForeignKeyConstraint(
        tableName,
        foreignKey.name,
        foreignKey.columns,
        foreignKey.referencedTable,
        foreignKey.referencedColumns,
      ),
    );
  });

  diff.removedUniqueConstraints.forEach(({ tableName, constraint }) => {
    upStatements.push(buildDropConstraint(tableName, constraint.name));
    downStatements.unshift(buildAddUniqueConstraint(tableName, constraint.name, constraint.columns));
  });

  diff.removedIndexes.forEach(({ tableName, index }) => {
    upStatements.push(buildDropIndex(index.name));
    downStatements.unshift(buildCreateIndex(tableName, index.name, index.columns));
  });

  diff.addedFields.forEach(({ model, field }) => {
    upStatements.push(buildAddColumn(model, field));
    downStatements.unshift(buildDropColumn(model, field));
  });

  diff.removedFields.forEach(({ model, field }) => {
    upStatements.push(buildDropColumn(model, field));
    downStatements.unshift(buildAddColumn(model, field));
  });

  diff.alteredFields.forEach((change) => {
    const alterations = buildAlterColumnChanges(change);
    upStatements.push(...alterations.up);
    downStatements.unshift(...alterations.down);
  });

  diff.primaryKeyChanges.forEach((change) => {
    if (change.current) {
      upStatements.push(buildAddPrimaryKeyConstraint(change.tableName, change.current.name, change.current.columns));
      downStatements.unshift(buildDropConstraint(change.tableName, change.current.name));
    }
  });

  diff.addedUniqueConstraints.forEach(({ tableName, constraint }) => {
    upStatements.push(buildAddUniqueConstraint(tableName, constraint.name, constraint.columns));
    downStatements.unshift(buildDropConstraint(tableName, constraint.name));
  });

  diff.addedIndexes.forEach(({ tableName, index }) => {
    upStatements.push(buildCreateIndex(tableName, index.name, index.columns));
    downStatements.unshift(buildDropIndex(index.name));
  });

  diff.addedForeignKeys.forEach(({ tableName, foreignKey }) => {
    upStatements.push(
      buildAddForeignKeyConstraint(
        tableName,
        foreignKey.name,
        foreignKey.columns,
        foreignKey.referencedTable,
        foreignKey.referencedColumns,
      ),
    );
    downStatements.unshift(buildDropConstraint(tableName, foreignKey.name));
  });

  return { upStatements, downStatements };
}

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

function formatStatements(statements: string[]): string {
  if (statements.length === 0) {
    return "  // No schema changes detected";
  }

  return statements.map((statement) => indentLines(statement, 2)).join("\n\n");
}

function indentLines(text: string, spaces: number): string {
  const indent = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export async function getSchemaDiff(options: MigrationOptions): Promise<DiffResult> {
  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath, options.snapshotPath);
  const previousSnapshot = await readSnapshot(snapshotPath);
  return applyRenameMappings(
    diffSchemas(previousSnapshot?.schema ?? null, currentSchema),
    options.renameTables,
    options.renameColumns,
  );
}

export async function hasSchemaChanges(options: MigrationOptions): Promise<boolean> {
  const diff = await getSchemaDiff(options);

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
    diff.primaryKeyChanges.length > 0 ||
    diff.renamedTables.length > 0 ||
    diff.renamedColumns.length > 0
  );
}

/**
 * Create a migration file from schema changes
 */
export async function createMigration(options: MigrationOptions): Promise<Migration | null> {
  if (!options.name) {
    throw new Error("Migration name is required");
  }

  const currentSchema = await generateSchemaSnapshot(options.schemaPath);
  const { snapshotPath } = getSnapshotPaths(options.outputPath, options.snapshotPath);
  const previousSnapshot = await readSnapshot(snapshotPath);

  const diff = applyRenameMappings(
    diffSchemas(previousSnapshot?.schema ?? null, currentSchema),
    options.renameTables,
    options.renameColumns,
  );
  const plan = buildMigrationPlan(diff);

  if (plan.upStatements.length === 0) {
    return null;
  }

  const timestamp = Date.now();
  const timestampStr = generateTimestamp();
  const safeName = options.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const filename = `${timestampStr}_${safeName}.ts`;

  const upContent = formatStatements(plan.upStatements);
  const downContent = formatStatements(plan.downStatements);

  const content = `// Migration: ${options.name}
// Generated at: ${new Date(timestamp).toISOString()}

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
${upContent}
}

export async function down(db: Kysely<any>): Promise<void> {
${downContent}
}
`;

  await fs.mkdir(options.outputPath, { recursive: true });

  const outputFile = path.join(options.outputPath, filename);
  await fs.writeFile(outputFile, content, "utf-8");

  await writeSnapshot(snapshotPath, currentSchema);

  return {
    filename,
    up: plan.upStatements.join("\n\n"),
    down: plan.downStatements.join("\n\n"),
    timestamp,
  };
}

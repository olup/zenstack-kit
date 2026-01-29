import type { KyselyDialect } from "../../sql/kysely-adapter.js";
import type { SchemaSnapshot, SchemaTable, SchemaColumn, SchemaEnum } from "../../schema/snapshot.js";
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
  compileCreateEnum,
  compileDropEnum,
  compileAddEnumValue,
} from "../../sql/compiler.js";

function diffTableChanges(previousModel: SchemaTable, currentModel: SchemaTable, tableName: string) {
  const addedFields: Array<{ tableName: string; column: SchemaColumn }> = [];
  const removedFields: Array<{ tableName: string; column: SchemaColumn }> = [];
  const alteredFields: Array<{
    tableName: string;
    columnName: string;
    previous: SchemaColumn;
    current: SchemaColumn;
  }> = [];
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

export function diffSchemas(previous: SchemaSnapshot | null, current: SchemaSnapshot) {
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

  const addedFields: Array<{ tableName: string; column: SchemaColumn }> = [];
  const removedFields: Array<{ tableName: string; column: SchemaColumn }> = [];
  const alteredFields: Array<{
    tableName: string;
    columnName: string;
    previous: SchemaColumn;
    current: SchemaColumn;
  }> = [];
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

    const modelDiff = diffTableChanges(previousModel, currentModel, tableName);
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

  // Diff enums
  const previousEnums = new Map<string, SchemaEnum>();
  const currentEnums = new Map<string, SchemaEnum>();

  (previous?.enums ?? []).forEach((e) => previousEnums.set(e.name, e));
  (current.enums ?? []).forEach((e) => currentEnums.set(e.name, e));

  const addedEnums: SchemaEnum[] = [];
  const removedEnums: SchemaEnum[] = [];
  const alteredEnums: Array<{
    enumName: string;
    addedValues: string[];
    removedValues: string[];
  }> = [];

  for (const [enumName, enumDef] of currentEnums.entries()) {
    if (!previousEnums.has(enumName)) {
      addedEnums.push(enumDef);
    }
  }

  for (const [enumName, enumDef] of previousEnums.entries()) {
    if (!currentEnums.has(enumName)) {
      removedEnums.push(enumDef);
    }
  }

  // Check for altered enums (added/removed values)
  for (const [enumName, currentEnum] of currentEnums.entries()) {
    const previousEnum = previousEnums.get(enumName);
    if (!previousEnum) continue;

    const prevValues = new Set(previousEnum.values);
    const currValues = new Set(currentEnum.values);

    const addedValues = currentEnum.values.filter((v) => !prevValues.has(v));
    const removedValues = previousEnum.values.filter((v) => !currValues.has(v));

    if (addedValues.length > 0 || removedValues.length > 0) {
      alteredEnums.push({ enumName, addedValues, removedValues });
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
    addedEnums,
    removedEnums,
    alteredEnums,
  };
}

type PrismaDiff = ReturnType<typeof diffSchemas>;

function columnsSignature(columns: string[]): string {
  return columns.join("|");
}

function consumeSignature(map: Map<string, number>, signature: string): boolean {
  const count = map.get(signature) ?? 0;
  if (count > 0) {
    map.set(signature, count - 1);
    return true;
  }
  return false;
}

function buildSignatureCount<T>(items: T[], getSignature: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const signature = getSignature(item);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function columnsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function filterRenamedConstraintChanges(
  previousModel: SchemaTable,
  currentModel: SchemaTable,
  modelDiff: ReturnType<typeof diffTableChanges>
): ReturnType<typeof diffTableChanges> {
  const prevUnique = buildSignatureCount(previousModel.uniqueConstraints, (c) => columnsSignature(c.columns));
  const currUnique = buildSignatureCount(currentModel.uniqueConstraints, (c) => columnsSignature(c.columns));
  const prevIndexes = buildSignatureCount(previousModel.indexes, (i) => columnsSignature(i.columns));
  const currIndexes = buildSignatureCount(currentModel.indexes, (i) => columnsSignature(i.columns));
  const prevFks = buildSignatureCount(
    previousModel.foreignKeys,
    (f) =>
      `${columnsSignature(f.columns)}->${f.referencedTable}:${columnsSignature(f.referencedColumns)}`
  );
  const currFks = buildSignatureCount(
    currentModel.foreignKeys,
    (f) =>
      `${columnsSignature(f.columns)}->${f.referencedTable}:${columnsSignature(f.referencedColumns)}`
  );

  const addedUniqueConstraints = modelDiff.addedUniqueConstraints.filter(
    ({ constraint }) => !consumeSignature(prevUnique, columnsSignature(constraint.columns))
  );
  const removedUniqueConstraints = modelDiff.removedUniqueConstraints.filter(
    ({ constraint }) => !consumeSignature(currUnique, columnsSignature(constraint.columns))
  );
  const addedIndexes = modelDiff.addedIndexes.filter(
    ({ index }) => !consumeSignature(prevIndexes, columnsSignature(index.columns))
  );
  const removedIndexes = modelDiff.removedIndexes.filter(
    ({ index }) => !consumeSignature(currIndexes, columnsSignature(index.columns))
  );
  const addedForeignKeys = modelDiff.addedForeignKeys.filter(
    ({ foreignKey }) =>
      !consumeSignature(
        prevFks,
        `${columnsSignature(foreignKey.columns)}->${foreignKey.referencedTable}:${columnsSignature(
          foreignKey.referencedColumns
        )}`
      )
  );
  const removedForeignKeys = modelDiff.removedForeignKeys.filter(
    ({ foreignKey }) =>
      !consumeSignature(
        currFks,
        `${columnsSignature(foreignKey.columns)}->${foreignKey.referencedTable}:${columnsSignature(
          foreignKey.referencedColumns
        )}`
      )
  );

  let primaryKeyChanges = modelDiff.primaryKeyChanges;
  if (previousModel.primaryKey && currentModel.primaryKey) {
    if (columnsEqual(previousModel.primaryKey.columns, currentModel.primaryKey.columns)) {
      primaryKeyChanges = [];
    }
  }

  return {
    ...modelDiff,
    addedUniqueConstraints,
    removedUniqueConstraints,
    addedIndexes,
    removedIndexes,
    addedForeignKeys,
    removedForeignKeys,
    primaryKeyChanges,
  };
}

export function applyRenameMappings(
  diff: PrismaDiff,
  renameTables: Array<{ from: string; to: string }> = [],
  renameColumns: Array<{ table: string; from: string; to: string }> = []
): PrismaDiff {
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
  const renamedTables: PrismaDiff["renamedTables"] = [];
  const renamedColumns: PrismaDiff["renamedColumns"] = [];
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

    const modelDiff = filterRenamedConstraintChanges(
      previousModel,
      currentModel,
      diffTableChanges(previousModel, currentModel, mapping.to)
    );
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

  const remapTableName = (tableName: string) => renamedTableMap.get(tableName) ?? tableName;
  const remapTableEntries = <T extends { tableName: string }>(items: T[]) =>
    items.map((item) => ({ ...item, tableName: remapTableName(item.tableName) }));

  if (renamedTableMap.size > 0) {
    removedFields.forEach((entry) => {
      const mapped = renamedTableMap.get(entry.tableName);
      if (mapped) {
        entry.tableName = mapped;
      }
    });
  }

  renameColumns.forEach((mapping) => {
    const mappedTable = remapTableName(mapping.table);
    const removedIdx = removedFields.findIndex(
      (f) => f.tableName === mappedTable && f.column.name === mapping.from
    );
    const addedIdx = addedFields.findIndex(
      (f) => f.tableName === mappedTable && f.column.name === mapping.to
    );
    if (removedIdx !== -1 && addedIdx !== -1) {
      removedFields.splice(removedIdx, 1);
      addedFields.splice(addedIdx, 1);
      renamedColumns.push({ tableName: mappedTable, from: mapping.from, to: mapping.to });
    }
  });

  return {
    ...diff,
    removedModels,
    addedModels,
    removedFields: remapTableEntries(removedFields),
    addedFields: remapTableEntries(addedFields),
    alteredFields: remapTableEntries(alteredFields),
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
export function buildSqlStatements(
  diff: ReturnType<typeof diffSchemas>,
  dialect: KyselyDialect
): { up: string[]; down: string[] } {
  const up: string[] = [];
  const down: string[] = [];
  const compileOpts = { dialect };

  // Create enums FIRST (before tables that use them)
  for (const enumDef of diff.addedEnums) {
    const sql = compileCreateEnum(enumDef, compileOpts);
    if (sql) {
      up.push(sql);
      const dropSql = compileDropEnum(enumDef.name, compileOpts);
      if (dropSql) down.unshift(dropSql);
    }
  }

  // Add new values to existing enums
  for (const altered of diff.alteredEnums) {
    for (const value of altered.addedValues) {
      const sql = compileAddEnumValue(altered.enumName, value, compileOpts);
      if (sql) {
        up.push(sql);
        // Note: PostgreSQL doesn't support removing enum values easily,
        // so we don't add a down migration for added values
      }
    }
    // Note: Removing enum values in PostgreSQL requires recreating the type
    // which is complex and potentially data-losing. We skip this for now.
    if (altered.removedValues.length > 0 && dialect === "postgres") {
      up.push(`-- WARNING: Removing enum values (${altered.removedValues.join(", ")}) from "${altered.enumName}" requires manual migration`);
    }
  }

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
          ...compileAlterColumn(
            change.tableName,
            change.columnName,
            { dropDefault: true },
            compileOpts
          )
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

  // Drop enums LAST (after tables that use them are dropped)
  for (const enumDef of diff.removedEnums) {
    const sql = compileDropEnum(enumDef.name, compileOpts);
    if (sql) {
      up.push(sql);
      const createSql = compileCreateEnum(enumDef, compileOpts);
      if (createSql) down.unshift(createSql);
    }
  }

  return { up, down };
}

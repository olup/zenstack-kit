import { generateSchemaSnapshot } from "../../schema/snapshot.js";
import { diffSchemas } from "./diff.js";
import { getSnapshotPaths, readSnapshot } from "./snapshot.js";

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

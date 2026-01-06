/**
 * Schema snapshot utilities for ZenStack schemas
 *
 * Uses ZenStack's AST to create a stable, diffable schema snapshot without Prisma.
 */

import { loadDocument } from "@zenstackhq/language";
import { isDataField, isDataModel, isEnum } from "@zenstackhq/language/ast";
import type {
  DataField,
  DataFieldAttribute,
  DataModel,
  DataModelAttribute,
} from "@zenstackhq/language/ast";

export interface DmmfField {
  name: string;
  dbName?: string | null;
  type: string;
  kind: "scalar" | "enum";
  isList: boolean;
  isRequired: boolean;
  isUnique: boolean;
  isId: boolean;
  hasDefault: boolean;
  default?: string | number | boolean;
  defaultKind?: string;
  isRelation: boolean;
}

export interface DmmfConstraint {
  name: string;
  columns: string[];
}

export interface DmmfIndex {
  name: string;
  columns: string[];
}

export interface DmmfForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface DmmfModel {
  name: string;
  tableName: string;
  fields: DmmfField[];
  primaryKey?: DmmfConstraint;
  uniqueConstraints: DmmfConstraint[];
  indexes: DmmfIndex[];
  foreignKeys: DmmfForeignKey[];
}

export interface DmmfSchema {
  models: DmmfModel[];
}

export interface DmmfSnapshot {
  version: 1;
  createdAt: string;
  schema: DmmfSchema;
}

function normalizeName(value: string): string {
  return value.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

type AttributeNode = DataModelAttribute | DataFieldAttribute;

function getAttribute(node: { attributes: AttributeNode[] }, name: string): AttributeNode | undefined {
  return node.attributes.find((attr) => attr.decl.$refText === name);
}

function getAttributeStringArg(attr: AttributeNode | undefined, names: string[]): string | undefined {
  if (!attr) return undefined;

  for (const arg of attr.args) {
    const paramName = arg.$resolvedParam?.name;
    if (paramName && names.includes(paramName)) {
      if (arg.value?.$type === "StringLiteral") {
        return arg.value.value;
      }
    }
  }

  const firstArg = attr.args[0];
  if (firstArg?.value?.$type === "StringLiteral") {
    return firstArg.value.value;
  }

  return undefined;
}

function getAttributeArrayRefs(attr: AttributeNode | undefined, name: string): string[] | undefined {
  if (!attr) return undefined;

  const arg = attr.args.find((item) => item.$resolvedParam?.name === name) ?? attr.args[0];
  if (!arg?.value || arg.value.$type !== "ArrayExpr") {
    return undefined;
  }

  const refs = arg.value.items
    .filter((item) => item.$type === "ReferenceExpr")
    .map((item) => item.target.$refText);

  return refs.length > 0 ? refs : undefined;
}

function getDefaultValue(field: DataField): { hasDefault: boolean; default?: string | number | boolean; defaultKind?: string } {
  const attr = getAttribute(field, "@default");
  if (!attr) {
    return { hasDefault: false };
  }

  const valueArg = attr.args.find((arg) => arg.$resolvedParam?.name === "value") ?? attr.args[0];
  const expr = valueArg?.value;

  if (!expr) {
    return { hasDefault: true };
  }

  if (expr.$type === "StringLiteral") {
    return { hasDefault: true, default: expr.value };
  }

  if (expr.$type === "NumberLiteral") {
    return { hasDefault: true, default: Number(expr.value) };
  }

  if (expr.$type === "BooleanLiteral") {
    return { hasDefault: true, default: expr.value };
  }

  if (expr.$type === "InvocationExpr") {
    return { hasDefault: true, defaultKind: expr.function.$refText };
  }

  return { hasDefault: true };
}

function getTableName(model: DataModel): string {
  const mapAttr = getAttribute(model, "@@map");
  const mapped = getAttributeStringArg(mapAttr, ["name", "map"]);
  return mapped ?? model.name.toLowerCase();
}

function getColumnName(field: DataField): string {
  const mapAttr = getAttribute(field, "@map");
  return getAttributeStringArg(mapAttr, ["name", "map"]) ?? field.name;
}

function buildPrimaryKeyName(tableName: string, explicitName?: string): string {
  return explicitName ?? `pk_${normalizeName(tableName)}`;
}

function buildUniqueName(tableName: string, columns: string[], explicitName?: string): string {
  if (explicitName) return explicitName;
  return `uniq_${normalizeName(tableName)}_${normalizeName(columns.join("_"))}`;
}

function buildIndexName(tableName: string, columns: string[], explicitName?: string): string {
  if (explicitName) return explicitName;
  return `idx_${normalizeName(tableName)}_${normalizeName(columns.join("_"))}`;
}

function buildForeignKeyName(
  tableName: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
  explicitName?: string,
): string {
  if (explicitName) return explicitName;
  return `fk_${normalizeName(tableName)}_${normalizeName(columns.join("_"))}_${normalizeName(
    referencedTable,
  )}_${normalizeName(referencedColumns.join("_"))}`;
}

function getFieldType(field: DataField): { type: string; kind: "scalar" | "enum"; isRelation: boolean } {
  const ref = field.type.reference?.ref;

  if (ref && isDataModel(ref)) {
    return { type: ref.name, kind: "scalar", isRelation: true };
  }

  if (ref && isEnum(ref)) {
    return { type: ref.name, kind: "enum", isRelation: false };
  }

  return { type: field.type.type ?? "String", kind: "scalar", isRelation: false };
}

function getRelationFieldNames(field: DataField): { fields: string[]; references: string[]; mapName?: string } | null {
  const relationAttr = getAttribute(field, "@relation");
  if (!relationAttr) return null;

  const fields = getAttributeArrayRefs(relationAttr, "fields");
  const references = getAttributeArrayRefs(relationAttr, "references");
  if (!fields || !references) return null;

  const mapName = getAttributeStringArg(relationAttr, ["map", "name"]);
  return { fields, references, mapName };
}

function buildFieldNameMap(model: DataModel): Map<string, string> {
  const map = new Map<string, string>();

  for (const field of model.fields) {
    if (!isDataField(field)) continue;
    map.set(field.name, getColumnName(field));
  }

  return map;
}

function parseModel(model: DataModel): DmmfModel {
  const tableName = getTableName(model);
  const fields: DmmfField[] = [];
  const fieldMap = new Map<string, DmmfField>();
  const fieldNameMap = buildFieldNameMap(model);

  for (const field of model.fields) {
    if (!isDataField(field)) continue;

    const typeInfo = getFieldType(field);
    const defaultInfo = getDefaultValue(field);
    const isId = !!getAttribute(field, "@id");
    const isUnique = !!getAttribute(field, "@unique");
    const columnName = getColumnName(field);

    const dmmfField: DmmfField = {
      name: field.name,
      dbName: columnName !== field.name ? columnName : null,
      type: typeInfo.type,
      kind: typeInfo.kind,
      isList: field.type.array ?? false,
      isRequired: !field.type.optional,
      isUnique,
      isId,
      hasDefault: defaultInfo.hasDefault,
      default: defaultInfo.default,
      defaultKind: defaultInfo.defaultKind,
      isRelation: typeInfo.isRelation,
    };

    fields.push(dmmfField);
    fieldMap.set(field.name, dmmfField);
  }

  const modelIdAttr = getAttribute(model, "@@id");
  const modelIdFields = getAttributeArrayRefs(modelIdAttr, "fields");
  const modelIdName = getAttributeStringArg(modelIdAttr, ["name", "map"]);

  const primaryKeyColumns = modelIdFields?.map((name) => fieldNameMap.get(name) ?? name) ?? [];
  const fieldIdColumns = fields
    .filter((field) => field.isId && !field.isRelation)
    .map((field) => field.dbName ?? field.name);

  const resolvedPrimaryKeyColumns = primaryKeyColumns.length > 0 ? primaryKeyColumns : fieldIdColumns;
  const primaryKey =
    resolvedPrimaryKeyColumns.length > 0
      ? {
          name: buildPrimaryKeyName(tableName, modelIdName),
          columns: resolvedPrimaryKeyColumns,
        }
      : undefined;

  const uniqueConstraints: DmmfConstraint[] = [];
  const uniqueAttrs = model.attributes.filter((attr) => attr.decl.$refText === "@@unique");

  for (const attr of uniqueAttrs) {
    const columns = getAttributeArrayRefs(attr, "fields");
    if (!columns || columns.length === 0) continue;

    const resolvedColumns = columns.map((name) => fieldNameMap.get(name) ?? name);
    const explicitName = getAttributeStringArg(attr, ["name", "map"]);

    uniqueConstraints.push({
      name: buildUniqueName(tableName, resolvedColumns, explicitName),
      columns: resolvedColumns,
    });
  }

  for (const field of fields) {
    if (!field.isUnique || field.isRelation) continue;
    const columnName = field.dbName ?? field.name;
    const constraintName = buildUniqueName(tableName, [columnName]);

    if (!uniqueConstraints.some((constraint) => constraint.name === constraintName)) {
      uniqueConstraints.push({ name: constraintName, columns: [columnName] });
    }
  }

  const indexes: DmmfIndex[] = [];
  const indexAttrs = model.attributes.filter((attr) => attr.decl.$refText === "@@index");

  for (const attr of indexAttrs) {
    const columns = getAttributeArrayRefs(attr, "fields");
    if (!columns || columns.length === 0) continue;

    const resolvedColumns = columns.map((name) => fieldNameMap.get(name) ?? name);
    const explicitName = getAttributeStringArg(attr, ["name", "map"]);

    indexes.push({
      name: buildIndexName(tableName, resolvedColumns, explicitName),
      columns: resolvedColumns,
    });
  }

  const foreignKeys: DmmfForeignKey[] = [];

  for (const field of model.fields) {
    if (!isDataField(field)) continue;
    const relation = getRelationFieldNames(field);
    if (!relation) continue;

    const refModel = field.type.reference?.ref;
    if (!refModel || !isDataModel(refModel)) continue;

    const referencedTable = getTableName(refModel);
    const referencedFieldMap = buildFieldNameMap(refModel);
    const referencedColumnNames = relation.references.map(
      (name) => referencedFieldMap.get(name) ?? name,
    );
    const columnNames = relation.fields.map((name) => fieldNameMap.get(name) ?? name);

    foreignKeys.push({
      name: buildForeignKeyName(
        tableName,
        columnNames,
        referencedTable,
        referencedColumnNames,
        relation.mapName,
      ),
      columns: columnNames,
      referencedTable,
      referencedColumns: referencedColumnNames,
    });
  }

  const sortedFields = fields
    .filter((field) => !field.isRelation)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: model.name,
    tableName,
    fields: sortedFields,
    primaryKey,
    uniqueConstraints: uniqueConstraints.sort((a, b) => a.name.localeCompare(b.name)),
    indexes: indexes.sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: foreignKeys.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function generateDmmfSchema(schemaPath: string): Promise<DmmfSchema> {
  const loadResult = await loadDocument(schemaPath);
  if (!loadResult.success) {
    const messages = loadResult.errors.map((error) => String(error)).join("\n");
    throw new Error(`Failed to load schema:\n${messages}`);
  }

  const dataModels = loadResult.model.declarations.filter(isDataModel);
  const models = dataModels
    .map((model) => parseModel(model))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));

  return { models };
}

export function createSnapshot(schema: DmmfSchema): DmmfSnapshot {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    schema,
  };
}

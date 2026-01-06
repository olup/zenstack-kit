#!/usr/bin/env node

/**
 * zenstack-kit CLI - Database tooling for ZenStack schemas
 *
 * Commands:
 *   migrate   Create or apply database migrations
 */

import { Command } from "commander";
import chalk from "chalk";
import { createMigration, getSchemaDiff } from "./migrations.js";
import { applyMigrations } from "./migrate-apply.js";
import { loadConfig } from "./config-loader.js";
import { getPromptProvider } from "./prompts.js";

const program = new Command();

program
  .name("zenstack-kit")
  .description("Drizzle-kit like CLI tooling for ZenStack schemas with Kysely support")
  .version("0.1.0");

program
  .command("migrate:generate")
  .description("Generate a new migration file")
  .option("-n, --name <name>", "Migration name")
  .option("-s, --schema <path>", "Path to ZenStack schema")
  .option("-m, --migrations <path>", "Migrations directory")
  .action(async (options) => {
    console.log(chalk.blue("Generating migration..."));
    try {
      const config = await loadConfig(process.cwd());
      const schemaPath = options.schema ?? config?.schema ?? "./schema.zmodel";
      const outputPath = options.migrations ?? config?.migrations?.migrationsFolder ?? "./migrations";

      const initialDiff = await getSchemaDiff({
        schemaPath,
        outputPath,
      });

      if (!hasAnyChanges(initialDiff)) {
        console.log(chalk.yellow("No schema changes detected"));
        return;
      }

      const renameTables = await promptTableRenames(initialDiff);
      const diffAfterTableRenames = await getSchemaDiff({
        schemaPath,
        outputPath,
        renameTables,
      });
      const renameColumns = await promptColumnRenames(diffAfterTableRenames);

      const finalDiff = await getSchemaDiff({
        schemaPath,
        outputPath,
        renameTables,
        renameColumns,
      });

      const confirmed = await confirmDestructiveChanges(finalDiff);
      if (!confirmed) {
        console.log(chalk.yellow("Migration generation cancelled"));
        return;
      }

      const name = options.name ?? (await promptForMigrationName("migration"));
      const migration = await createMigration({
        name,
        schemaPath,
        outputPath,
        renameTables,
        renameColumns,
      });

      if (!migration) {
        console.log(chalk.yellow("No schema changes detected"));
        return;
      }

      console.log(chalk.green(`✓ Migration created: ${migration.filename}`));
    } catch (error) {
      console.error(chalk.red("Error creating migration:"), error);
      process.exit(1);
    }
  });

program
  .command("migrate:apply")
  .description("Apply migrations using Kysely migrator")
  .option("-m, --migrations <path>", "Migrations directory")
  .option("--dialect <dialect>", "Database dialect (sqlite, postgres, mysql)")
  .option("--url <url>", "Database connection URL")
  .action(async (options) => {
    console.log(chalk.blue("Applying migrations..."));
    try {
      const config = await loadConfig(process.cwd());
      const outputPath = options.migrations ?? config?.migrations?.migrationsFolder ?? "./migrations";
      const dialect = (options.dialect ?? config?.dialect ?? "sqlite") as
        | "sqlite"
        | "postgres"
        | "mysql";
      const connectionUrl = options.url ?? config?.dbCredentials?.url;
      if (dialect !== "sqlite" && !connectionUrl) {
        throw new Error("Database connection URL is required for non-sqlite dialects");
      }
      const databasePath = dialect === "sqlite" ? resolveSqlitePath(connectionUrl) : undefined;

      const result = await applyMigrations({
        migrationsFolder: outputPath,
        dialect,
        connectionUrl,
        databasePath,
      });

      if (result.results.length === 0) {
        console.log(chalk.yellow("No pending migrations"));
        return;
      }

      result.results.forEach((item) => {
        const color = item.status === "Success" ? chalk.green : chalk.red;
        console.log(color(`${item.status}: ${item.migrationName}`));
      });
    } catch (error) {
      console.error(chalk.red("Error applying migrations:"), error);
      process.exit(1);
    }
  });

program.parse();

async function promptForMigrationName(defaultName: string): Promise<string> {
  const prompt = getPromptProvider();
  const answer = await prompt.question(`Migration name (${defaultName}): `);

  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : defaultName;
}

async function promptTableRenames(diff: Awaited<ReturnType<typeof getSchemaDiff>>) {
  const removed = diff.removedModels.map((model) => model.name);
  const added = diff.addedModels.map((model) => model.name);
  const mappings: Array<{ from: string; to: string }> = [];

  let available = [...added];

  for (const table of removed) {
    if (available.length === 0) {
      break;
    }
    const answer = await promptChoice(
      `Table '${table}' was removed. Rename to one of [${available.join(", ")}] or leave blank to delete: `,
    );
    if (!answer) {
      continue;
    }
    if (available.includes(answer)) {
      mappings.push({ from: table, to: answer });
      available = available.filter((item) => item !== answer);
    }
  }

  return mappings;
}

async function promptColumnRenames(diff: Awaited<ReturnType<typeof getSchemaDiff>>) {
  const removedByTable = new Map<string, string[]>();
  const addedByTable = new Map<string, string[]>();

  diff.removedFields.forEach((entry) => {
    if (!removedByTable.has(entry.tableName)) {
      removedByTable.set(entry.tableName, []);
    }
    removedByTable.get(entry.tableName)?.push(entry.columnName);
  });

  diff.addedFields.forEach((entry) => {
    if (!addedByTable.has(entry.tableName)) {
      addedByTable.set(entry.tableName, []);
    }
    addedByTable.get(entry.tableName)?.push(entry.columnName);
  });

  const mappings: Array<{ table: string; from: string; to: string }> = [];

  for (const [table, removedColumns] of removedByTable.entries()) {
    const addedColumns = [...(addedByTable.get(table) ?? [])];
    if (addedColumns.length === 0) {
      continue;
    }

    for (const column of removedColumns) {
      if (addedColumns.length === 0) {
        break;
      }
      const answer = await promptChoice(
        `Column '${table}.${column}' was removed. Rename to one of [${addedColumns.join(", ")}] or leave blank to delete: `,
      );
      if (!answer) {
        continue;
      }
      if (addedColumns.includes(answer)) {
        mappings.push({ table, from: column, to: answer });
        const next = addedColumns.filter((item) => item !== answer);
        addedByTable.set(table, next);
      }
    }
  }

  return mappings;
}

async function confirmDestructiveChanges(diff: Awaited<ReturnType<typeof getSchemaDiff>>) {
  const removedTables = diff.removedModels.map((model) => model.name);
  const removedColumns = diff.removedFields.map((field) => `${field.tableName}.${field.columnName}`);

  if (removedTables.length === 0 && removedColumns.length === 0) {
    return true;
  }

  const summary = [
    removedTables.length > 0 ? `tables: ${removedTables.join(", ")}` : null,
    removedColumns.length > 0 ? `columns: ${removedColumns.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const answer = await promptChoice(
    `Destructive changes detected (${summary}). Proceed? (y/N): `,
  );
  return answer.toLowerCase() === "y";
}

async function promptChoice(message: string): Promise<string> {
  const prompt = getPromptProvider();
  const answer = await prompt.question(message);
  return answer.trim();
}

function hasAnyChanges(diff: Awaited<ReturnType<typeof getSchemaDiff>>) {
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

function resolveSqlitePath(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("file:")) {
    return url.slice("file:".length);
  }
  return url;
}

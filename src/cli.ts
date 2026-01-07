#!/usr/bin/env node

/**
 * zenstack-kit CLI - Database tooling for ZenStack schemas
 *
 * Commands:
 *   migrate:generate  Generate a new SQL migration
 *   migrate:apply     Apply pending migrations
 *   init              Initialize snapshot from existing schema
 *   pull              Introspect database and generate schema
 */

import { Command } from "commander";
import chalk from "chalk";
import { initSnapshot } from "./migrations.js";
import { loadConfig } from "./config-loader.js";
import { getPromptProvider } from "./prompts.js";
import { pullSchema } from "./pull.js";
import {
  createPrismaMigration,
  applyPrismaMigrations,
  hasPrismaSchemaChanges,
} from "./prisma-migrations.js";

const program = new Command();

program
  .name("zenstack-kit")
  .description("Drizzle-kit like CLI tooling for ZenStack schemas with Kysely support")
  .version("0.1.0");

program
  .command("migrate:generate")
  .description("Generate a new SQL migration file")
  .option("-n, --name <name>", "Migration name")
  .option("-s, --schema <path>", "Path to ZenStack schema")
  .option("-m, --migrations <path>", "Migrations directory")
  .option("--dialect <dialect>", "Database dialect (sqlite, postgres, mysql)")
  .action(async (options) => {
    console.log(chalk.blue("Generating migration..."));
    try {
      const config = await loadConfig(process.cwd());
      const schemaPath = options.schema ?? config?.schema ?? "./schema.zmodel";
      const outputPath =
        options.migrations ?? config?.migrations?.migrationsFolder ?? "./prisma/migrations";
      const dialect = (options.dialect ?? config?.dialect ?? "sqlite") as
        | "sqlite"
        | "postgres"
        | "mysql";

      // Check for changes first
      const hasChanges = await hasPrismaSchemaChanges({
        schemaPath,
        outputPath,
      });

      if (!hasChanges) {
        console.log(chalk.yellow("No schema changes detected"));
        return;
      }

      // Get migration name
      const name = options.name ?? (await promptForMigrationName("migration"));

      // TODO: Add rename prompts and destructive change confirmation
      // For now, we generate without prompts

      const migration = await createPrismaMigration({
        name,
        schemaPath,
        outputPath,
        dialect,
      });

      if (!migration) {
        console.log(chalk.yellow("No schema changes detected"));
        return;
      }

      console.log(chalk.green(`✓ Migration created: ${migration.folderName}/migration.sql`));
      console.log(chalk.gray(`  Path: ${migration.folderPath}`));
    } catch (error) {
      console.error(chalk.red("Error creating migration:"), error);
      process.exit(1);
    }
  });

program
  .command("migrate:apply")
  .description("Apply pending SQL migrations")
  .option("-m, --migrations <path>", "Migrations directory")
  .option("--dialect <dialect>", "Database dialect (sqlite, postgres, mysql)")
  .option("--url <url>", "Database connection URL")
  .option("--table <name>", "Migrations table name (default: _prisma_migrations)")
  .option("--schema <name>", "Migrations schema (PostgreSQL only, default: public)")
  .action(async (options) => {
    console.log(chalk.blue("Applying migrations..."));
    try {
      const config = await loadConfig(process.cwd());
      const outputPath =
        options.migrations ?? config?.migrations?.migrationsFolder ?? "./prisma/migrations";
      const dialect = (options.dialect ?? config?.dialect ?? "sqlite") as
        | "sqlite"
        | "postgres"
        | "mysql";
      const connectionUrl = options.url ?? config?.dbCredentials?.url;
      const migrationsTable =
        options.table ?? config?.migrations?.migrationsTable ?? "_prisma_migrations";
      const migrationsSchema =
        options.schema ?? config?.migrations?.migrationsSchema ?? "public";

      if (dialect !== "sqlite" && !connectionUrl) {
        throw new Error("Database connection URL is required for non-sqlite dialects");
      }

      const databasePath = dialect === "sqlite" ? resolveSqlitePath(connectionUrl) : undefined;

      const result = await applyPrismaMigrations({
        migrationsFolder: outputPath,
        dialect,
        connectionUrl,
        databasePath,
        migrationsTable,
        migrationsSchema,
      });

      if (result.applied.length === 0 && !result.failed) {
        console.log(chalk.yellow("No pending migrations"));
        if (result.alreadyApplied.length > 0) {
          console.log(chalk.gray(`  ${result.alreadyApplied.length} migration(s) already applied`));
        }
        return;
      }

      for (const item of result.applied) {
        console.log(chalk.green(`✓ Applied: ${item.migrationName} (${item.duration}ms)`));
      }

      if (result.failed) {
        console.log(chalk.red(`✗ Failed: ${result.failed.migrationName}`));
        console.log(chalk.red(`  Error: ${result.failed.error}`));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red("Error applying migrations:"), error);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Initialize snapshot from existing schema (baseline for migrations)")
  .option("-s, --schema <path>", "Path to ZenStack schema")
  .option("-m, --migrations <path>", "Migrations directory")
  .action(async (options) => {
    console.log(chalk.blue("Initializing snapshot..."));
    try {
      const config = await loadConfig(process.cwd());
      const schemaPath = options.schema ?? config?.schema ?? "./schema.zmodel";
      const outputPath =
        options.migrations ?? config?.migrations?.migrationsFolder ?? "./prisma/migrations";

      const result = await initSnapshot({
        schemaPath,
        outputPath,
      });

      console.log(chalk.green(`✓ Snapshot created: ${result.snapshotPath}`));
      console.log(chalk.gray(`  ${result.tableCount} table(s) captured`));
    } catch (error) {
      console.error(chalk.red("Error initializing snapshot:"), error);
      process.exit(1);
    }
  });

program
  .command("pull")
  .description("Introspect database and generate ZenStack schema")
  .option("-o, --output <path>", "Output path for schema", "./schema.zmodel")
  .option("--dialect <dialect>", "Database dialect (sqlite, postgres, mysql)")
  .option("--url <url>", "Database connection URL")
  .action(async (options) => {
    console.log(chalk.blue("Pulling schema from database..."));
    try {
      const config = await loadConfig(process.cwd());
      const dialect = (options.dialect ?? config?.dialect ?? "sqlite") as
        | "sqlite"
        | "postgres"
        | "mysql";
      const connectionUrl = options.url ?? config?.dbCredentials?.url;

      if (dialect !== "sqlite" && !connectionUrl) {
        throw new Error("Database connection URL is required for non-sqlite dialects");
      }

      const databasePath = dialect === "sqlite" ? resolveSqlitePath(connectionUrl) : undefined;

      const result = await pullSchema({
        dialect,
        connectionUrl,
        databasePath,
        outputPath: options.output,
      });

      console.log(chalk.green(`✓ Schema generated: ${result.outputPath}`));
      console.log(chalk.gray(`  ${result.tableCount} table(s) introspected`));
    } catch (error) {
      console.error(chalk.red("Error pulling schema:"), error);
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

function resolveSqlitePath(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("file:")) {
    return url.slice("file:".length);
  }
  return url;
}

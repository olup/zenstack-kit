/**
 * Command implementations for zenstack-kit CLI
 *
 * These functions contain the core logic and can be tested independently
 * from the CLI/UI layer.
 */

import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config/loader.js";
import { pullSchema } from "../schema/pull.js";
import {
  createPrismaMigration,
  applyPrismaMigrations,
  hasPrismaSchemaChanges,
  hasSnapshot,
  scanMigrationFolders,
  writeMigrationLog,
  initializeSnapshot,
  createInitialMigration,
} from "../migrations/prisma.js";
import type { ZenStackKitConfig } from "../config/index.js";

export type LogFn = (type: "info" | "success" | "error" | "warning", message: string) => void;

export interface CommandOptions {
  schema?: string;
  migrations?: string;
  name?: string;
  dialect?: string;
  url?: string;
  output?: string;
  table?: string;
  dbSchema?: string;
  baseline?: boolean;
  createInitial?: boolean;
}

export interface CommandContext {
  cwd: string;
  options: CommandOptions;
  log: LogFn;
  promptSnapshotExists?: () => Promise<"skip" | "reinitialize">;
  promptFreshInit?: () => Promise<"baseline" | "create_initial">;
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Load and validate config, returning resolved paths
 */
export async function resolveConfig(ctx: CommandContext): Promise<{
  config: ZenStackKitConfig;
  schemaPath: string;
  outputPath: string;
  dialect: "sqlite" | "postgres" | "mysql";
}> {
  const loaded = await loadConfig(ctx.cwd);

  if (!loaded) {
    throw new CommandError("No zenstack-kit config file found.");
  }

  const { config, configDir } = loaded;

  const relativeSchemaPath = ctx.options.schema || config.schema || "./schema.zmodel";
  const relativeOutputPath = ctx.options.migrations || config.migrations?.migrationsFolder || "./prisma/migrations";
  const dialect = (ctx.options.dialect || config.dialect || "sqlite") as "sqlite" | "postgres" | "mysql";

  // Resolve paths relative to config file location
  const schemaPath = path.resolve(configDir, relativeSchemaPath);
  const outputPath = path.resolve(configDir, relativeOutputPath);

  return { config, schemaPath, outputPath, dialect };
}

/**
 * Validate that the schema file exists (schemaPath should be absolute)
 */
export function validateSchemaExists(schemaPath: string): void {
  if (!fs.existsSync(schemaPath)) {
    throw new CommandError(`ZenStack schema file not found: ${schemaPath}`);
  }
}

/**
 * Get connection URL from config based on dialect
 */
export function getConnectionUrl(
  config: ZenStackKitConfig,
  dialect: "sqlite" | "postgres" | "mysql"
): string | undefined {
  const dbCredentials = config.dbCredentials as Record<string, unknown> | undefined;
  return dialect === "sqlite"
    ? (dbCredentials?.file as string | undefined)
    : (dbCredentials?.url as string | undefined);
}

/**
 * migrate:generate command
 */
export async function runMigrateGenerate(ctx: CommandContext): Promise<void> {
  const { config, schemaPath, outputPath, dialect } = await resolveConfig(ctx);

  validateSchemaExists(schemaPath);

  const snapshotExists = await hasSnapshot(outputPath);
  if (!snapshotExists) {
    throw new CommandError("No snapshot found. Run 'zenstack-kit init' first.");
  }

  ctx.log("info", "Generating migration...");

  const hasChanges = await hasPrismaSchemaChanges({
    schemaPath,
    outputPath,
  });

  if (!hasChanges) {
    ctx.log("warning", "No schema changes detected");
    return;
  }

  const name = ctx.options.name || "migration";

  const migration = await createPrismaMigration({
    name,
    schemaPath,
    outputPath,
    dialect,
  });

  if (!migration) {
    ctx.log("warning", "No schema changes detected");
    return;
  }

  ctx.log("success", `Migration created: ${migration.folderName}/migration.sql`);
  ctx.log("info", `Path: ${migration.folderPath}`);
}

/**
 * migrate:apply command
 */
export async function runMigrateApply(ctx: CommandContext): Promise<void> {
  const { config, outputPath, dialect } = await resolveConfig(ctx);

  const connectionUrl = getConnectionUrl(config, dialect);

  const migrationsTable = ctx.options.table || config.migrations?.migrationsTable || "_prisma_migrations";
  const migrationsSchema =
    ctx.options.dbSchema ||
    (config.migrations as { migrationsSchema?: string } | undefined)?.migrationsSchema ||
    "public";

  const snapshotExists = await hasSnapshot(outputPath);
  if (!snapshotExists) {
    throw new CommandError("No snapshot found. Run 'zenstack-kit init' first.");
  }

  const migrations = await scanMigrationFolders(outputPath);
  if (migrations.length === 0) {
    throw new CommandError("No migrations found.");
  }

  if (dialect !== "sqlite" && !connectionUrl) {
    throw new CommandError("Database connection URL is required for non-sqlite dialects.");
  }

  ctx.log("info", "Applying migrations...");

  const databasePath = dialect === "sqlite" ? connectionUrl : undefined;

  const result = await applyPrismaMigrations({
    migrationsFolder: outputPath,
    dialect,
    connectionUrl,
    databasePath,
    migrationsTable,
    migrationsSchema,
  });

  if (result.applied.length === 0 && !result.failed) {
    ctx.log("warning", "No pending migrations");
    if (result.alreadyApplied.length > 0) {
      ctx.log("info", `${result.alreadyApplied.length} migration(s) already applied`);
    }
    return;
  }

  for (const item of result.applied) {
    ctx.log("success", `Applied: ${item.migrationName} (${item.duration}ms)`);
  }

  if (result.failed) {
    throw new CommandError(`Migration failed: ${result.failed.migrationName} - ${result.failed.error}`);
  }
}

/**
 * init command
 */
export async function runInit(ctx: CommandContext): Promise<void> {
  const { config, schemaPath, outputPath, dialect } = await resolveConfig(ctx);

  validateSchemaExists(schemaPath);

  const snapshotExists = await hasSnapshot(outputPath);
  const existingMigrations = await scanMigrationFolders(outputPath);

  // CASE A: Snapshot already exists
  if (snapshotExists) {
    if (!ctx.promptSnapshotExists) {
      throw new CommandError("Snapshot already exists and no prompt handler provided.");
    }

    const choice = await ctx.promptSnapshotExists();

    if (choice === "skip") {
      ctx.log("warning", "Skipped - no changes made");
      return;
    }

    ctx.log("info", "Reinitializing...");

    const result = await initializeSnapshot({ schemaPath, outputPath });
    const migrations = await scanMigrationFolders(outputPath);
    await writeMigrationLog(outputPath, migrations);

    ctx.log("success", `Snapshot recreated: ${result.snapshotPath}`);
    ctx.log("success", `Migration log rebuilt with ${migrations.length} migration(s)`);
    ctx.log("info", `${result.tableCount} table(s) captured`);
    return;
  }

  // CASE B: No snapshot but migrations exist (takeover mode)
  if (existingMigrations.length > 0) {
    ctx.log("info", "Initializing snapshot...");
    ctx.log("warning", `Found ${existingMigrations.length} existing migration(s) without snapshot.`);
    ctx.log("info", "Taking over from existing migrations...");

    for (const migration of existingMigrations) {
      ctx.log("info", `${migration.name} (${migration.checksum.slice(0, 8)}...)`);
    }

    const result = await initializeSnapshot({ schemaPath, outputPath });
    await writeMigrationLog(outputPath, existingMigrations);

    ctx.log("success", `Snapshot created: ${result.snapshotPath}`);
    ctx.log("success", `Migration log created with ${existingMigrations.length} migration(s)`);
    ctx.log("info", `${result.tableCount} table(s) captured`);
    return;
  }

  // CASE C: Fresh init (no snapshot, no migrations)
  let choice: "baseline" | "create_initial";
  if (ctx.options.baseline) {
    choice = "baseline";
  } else if (ctx.options.createInitial) {
    choice = "create_initial";
  } else if (ctx.promptFreshInit) {
    choice = await ctx.promptFreshInit();
  } else {
    throw new CommandError("Fresh init requires --baseline or --create-initial flag, or a prompt handler.");
  }

  if (choice === "baseline") {
    ctx.log("info", "Creating baseline snapshot...");

    const result = await initializeSnapshot({ schemaPath, outputPath });
    await writeMigrationLog(outputPath, []);

    ctx.log("success", `Snapshot created: ${result.snapshotPath}`);
    ctx.log("success", "Empty migration log created");
    ctx.log("info", `${result.tableCount} table(s) captured`);
    ctx.log("info", "Baselined. Future changes will generate migrations.");
    return;
  }

  // Create initial migration
  ctx.log("info", "Creating initial migration...");

  const migration = await createInitialMigration({
    name: "init",
    schemaPath,
    outputPath,
    dialect,
  });

  ctx.log("success", `Initial migration created: ${migration.folderName}/migration.sql`);
  ctx.log("info", `Path: ${migration.folderPath}`);
  ctx.log("info", "Run migrate:apply to set up the database.");
}

/**
 * pull command
 */
export async function runPull(ctx: CommandContext): Promise<void> {
  const { config, dialect } = await resolveConfig(ctx);

  const connectionUrl = getConnectionUrl(config, dialect);

  if (dialect !== "sqlite" && !connectionUrl) {
    throw new CommandError("Database connection URL is required for non-sqlite dialects.");
  }

  ctx.log("info", "Pulling schema from database...");

  const databasePath = dialect === "sqlite" ? connectionUrl : undefined;
  const outputPath = ctx.options.output || "./schema.zmodel";

  const result = await pullSchema({
    dialect,
    connectionUrl,
    databasePath,
    outputPath,
  });

  ctx.log("success", `Schema generated: ${result.outputPath}`);
  ctx.log("info", `${result.tableCount} table(s) introspected`);
}

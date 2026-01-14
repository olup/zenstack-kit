/**
 * Command implementations for zenstack-kit CLI
 *
 * These functions contain the core logic and can be tested independently
 * from the CLI/UI layer.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { loadConfig } from "../config/loader.js";
import { pullSchema } from "../schema/pull.js";
import {
  createPrismaMigration,
  applyPrismaMigrations,
  previewPrismaMigrations,
  hasPrismaSchemaChanges,
  hasSnapshot,
  scanMigrationFolders,
  readMigrationLog,
  writeMigrationLog,
  getMigrationLogPath,
  calculateChecksum,
  initializeSnapshot,
  createInitialMigration,
  detectPotentialRenames,
} from "../migrations/prisma.js";
import type { RenameChoice, MigrationConfirmChoice } from "./prompts.js";
import type { ZenStackKitConfig } from "../config/index.js";

export type LogFn = (type: "info" | "success" | "error" | "warning", message: string) => void;

export interface CommandOptions {
  schema?: string;
  migrations?: string;
  name?: string;
  migration?: string;
  dialect?: string;
  url?: string;
  output?: string;
  table?: string;
  dbSchema?: string;
  baseline?: boolean;
  createInitial?: boolean;
  preview?: boolean;
  markApplied?: boolean;
  force?: boolean;
  config?: string;
}

export interface CommandContext {
  cwd: string;
  options: CommandOptions;
  log: LogFn;
  promptSnapshotExists?: () => Promise<"skip" | "reinitialize">;
  promptFreshInit?: () => Promise<"baseline" | "create_initial">;
  promptPullConfirm?: (existingFiles: string[]) => Promise<boolean>;
  promptTableRename?: (from: string, to: string) => Promise<RenameChoice>;
  promptColumnRename?: (table: string, from: string, to: string) => Promise<RenameChoice>;
  promptMigrationName?: (defaultName: string) => Promise<string>;
  promptMigrationConfirm?: (migrationPath: string) => Promise<MigrationConfirmChoice>;
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
  configDir: string;
  schemaPath: string;
  outputPath: string;
  dialect: "sqlite" | "postgres" | "mysql";
}> {
  const loaded = await loadConfig(ctx.cwd, ctx.options.config);

  if (!loaded) {
    if (ctx.options.config) {
      throw new CommandError(`Config file not found: ${ctx.options.config}`);
    }
    throw new CommandError("No zenstack-kit config file found.");
  }

  const { config, configDir } = loaded;

  const relativeSchemaPath = ctx.options.schema || config.schema || "./schema.zmodel";
  const relativeOutputPath = ctx.options.migrations || config.migrations?.migrationsFolder || "./prisma/migrations";
  const dialect = (ctx.options.dialect || config.dialect || "sqlite") as "sqlite" | "postgres" | "mysql";

  // Resolve paths relative to config file location
  const schemaPath = path.resolve(configDir, relativeSchemaPath);
  const outputPath = path.resolve(configDir, relativeOutputPath);

  return { config, configDir, schemaPath, outputPath, dialect };
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

  // Detect potential renames and prompt user to disambiguate
  const potentialRenames = await detectPotentialRenames({ schemaPath, outputPath });

  const renameTables: Array<{ from: string; to: string }> = [];
  const renameColumns: Array<{ table: string; from: string; to: string }> = [];

  // Prompt for table renames
  for (const rename of potentialRenames.tables) {
    if (ctx.promptTableRename) {
      const choice = await ctx.promptTableRename(rename.from, rename.to);
      if (choice === "rename") {
        renameTables.push(rename);
      }
    }
  }

  // Prompt for column renames
  for (const rename of potentialRenames.columns) {
    if (ctx.promptColumnRename) {
      const choice = await ctx.promptColumnRename(rename.table, rename.from, rename.to);
      if (choice === "rename") {
        renameColumns.push(rename);
      }
    }
  }

  // Prompt for migration name if not provided via flag
  let name = ctx.options.name;
  if (!name && ctx.promptMigrationName) {
    name = await ctx.promptMigrationName("migration");
  }
  name = name || "migration";

  // Compute expected migration path for confirmation
  const safeName = name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const expectedPath = path.join(outputPath, `<timestamp>_${safeName}`, "migration.sql");

  // Prompt for confirmation before creating
  if (ctx.promptMigrationConfirm) {
    const confirmChoice = await ctx.promptMigrationConfirm(expectedPath);
    if (confirmChoice === "cancel") {
      ctx.log("warning", "Migration creation cancelled");
      return;
    }
  }

  const migration = await createPrismaMigration({
    name,
    schemaPath,
    outputPath,
    dialect,
    renameTables: renameTables.length > 0 ? renameTables : undefined,
    renameColumns: renameColumns.length > 0 ? renameColumns : undefined,
  });

  if (!migration) {
    ctx.log("warning", "No schema changes detected");
    return;
  }

  ctx.log("success", `Migration created: ${migration.folderName}/migration.sql`);
  ctx.log("info", `Path: ${migration.folderPath}`);
  ctx.log("info", "Next: run 'zenstack-kit migrate apply' (or --preview to review SQL).");
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

  const databasePath = dialect === "sqlite" ? connectionUrl : undefined;

  if (ctx.options.preview && ctx.options.markApplied) {
    throw new CommandError("Cannot use --preview and --mark-applied together.");
  }

  // Preview mode - show pending migrations without applying
  if (ctx.options.preview) {
    ctx.log("info", "Preview mode - no changes will be applied.");

    const preview = await previewPrismaMigrations({
      migrationsFolder: outputPath,
      dialect,
      connectionUrl,
      databasePath,
      migrationsTable,
      migrationsSchema,
    });

    if (preview.pending.length === 0) {
      ctx.log("warning", "No pending migrations");
      if (preview.alreadyApplied.length > 0) {
        ctx.log("info", `${preview.alreadyApplied.length} migration(s) already applied`);
      }
      return;
    }

    ctx.log("info", `Pending migrations: ${preview.pending.length}`);
    if (preview.alreadyApplied.length > 0) {
      ctx.log("info", `${preview.alreadyApplied.length} migration(s) already applied`);
    }
    for (const migration of preview.pending) {
      const statementCount = migration.sql
        .split(/;(?:\s*\n|\s*$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--")).length;
      ctx.log("info", `Migration: ${migration.name} (${statementCount} statement${statementCount === 1 ? "" : "s"})`);
    }
    ctx.log("info", "Use the migration.sql files to review full SQL.");
    return;
  }

  if (ctx.options.markApplied) {
    ctx.log("info", "Marking migrations as applied (no SQL will be executed)...");
  } else {
    ctx.log("info", "Applying migrations...");
  }

  const result = await applyPrismaMigrations({
    migrationsFolder: outputPath,
    dialect,
    connectionUrl,
    databasePath,
    migrationsTable,
    migrationsSchema,
    markApplied: ctx.options.markApplied,
  });

  // Handle coherence errors
  if (result.coherenceErrors && result.coherenceErrors.length > 0) {
    ctx.log("error", "Migration history is inconsistent");
    ctx.log("error", "");
    ctx.log("error", "The following issues were found:");

    for (const err of result.coherenceErrors) {
      ctx.log("error", `  - ${err.details}`);
    }

    ctx.log("error", "");
    ctx.log("error", "This can happen when:");
    ctx.log("error", "  - Migrations were applied manually without using zenstack-kit");
    ctx.log("error", "  - The migration log file was modified or deleted");
    ctx.log("error", "  - Different migration histories exist across environments");
    ctx.log("error", "  - Migration.sql files were edited after being logged");
    ctx.log("error", "");
    ctx.log("error", "To resolve, ensure your migration log matches your database state.");
    ctx.log("error", "If you edited migration.sql files, run 'zenstack-kit migrate rehash' to rebuild log checksums.");

    throw new CommandError("Migration history is inconsistent");
  }

  if (result.applied.length === 0 && !result.failed) {
    ctx.log("warning", "No pending migrations");
    if (result.alreadyApplied.length > 0) {
      ctx.log("info", `${result.alreadyApplied.length} migration(s) already applied`);
    }
    return;
  }

  for (const item of result.applied) {
    const action = ctx.options.markApplied ? "Marked applied" : "Applied";
    ctx.log("success", `${action}: ${item.migrationName} (${item.duration}ms)`);
  }

  if (result.failed) {
    throw new CommandError(`Migration failed: ${result.failed.migrationName} - ${result.failed.error}`);
  }
}

/**
 * migrate:rehash command
 */
export async function runMigrateRehash(ctx: CommandContext): Promise<void> {
  const { outputPath } = await resolveConfig(ctx);

  const targetMigration = ctx.options.migration;
  if (targetMigration) {
    const sqlPath = path.join(outputPath, targetMigration, "migration.sql");
    if (!fs.existsSync(sqlPath)) {
      throw new CommandError(`Migration not found: ${targetMigration}`);
    }

    const sqlContent = await fs.promises.readFile(sqlPath, "utf-8");
    const checksum = calculateChecksum(sqlContent);

    const entries = await readMigrationLog(outputPath);
    const existingIndex = entries.findIndex((e) => e.name === targetMigration);
    if (existingIndex === -1) {
      entries.push({ name: targetMigration, checksum });
    } else {
      entries[existingIndex] = { name: targetMigration, checksum };
    }

    await writeMigrationLog(outputPath, entries);

    const logPath = getMigrationLogPath(outputPath);
    ctx.log("success", `Updated checksum for ${targetMigration}`);
    ctx.log("info", `Log: ${logPath}`);
    ctx.log(
      "warning",
      "If this migration was already applied, make sure the database checksum matches the updated log."
    );
    return;
  }

  const migrations = await scanMigrationFolders(outputPath);
  if (migrations.length === 0) {
    ctx.log("warning", "No migrations found.");
    return;
  }

  await writeMigrationLog(outputPath, migrations);

  const logPath = getMigrationLogPath(outputPath);
  ctx.log("success", `Migration log rebuilt with ${migrations.length} migration(s)`);
  ctx.log("info", `Log: ${logPath}`);
  ctx.log(
    "warning",
    "If these migrations were already applied, make sure the database checksums match the updated log."
  );
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
  const { config, configDir, dialect, outputPath: migrationsPath } = await resolveConfig(ctx);

  const connectionUrl = getConnectionUrl(config, dialect);

  if (dialect !== "sqlite" && !connectionUrl) {
    throw new CommandError("Database connection URL is required for non-sqlite dialects.");
  }

  const databasePath = dialect === "sqlite" ? connectionUrl : undefined;
  const relativeSchemaOutputPath = ctx.options.output || config.schema || "./schema.zmodel";
  const schemaOutputPath = path.resolve(configDir, relativeSchemaOutputPath);

  // Check for existing files that would be affected
  const existingFiles: string[] = [];

  if (fs.existsSync(schemaOutputPath)) {
    existingFiles.push(`Schema: ${schemaOutputPath}`);
  }

  const snapshotExists = await hasSnapshot(migrationsPath);
  if (snapshotExists) {
    existingFiles.push(`Snapshot: ${migrationsPath}/meta/_snapshot.json`);
  }

  const migrations = await scanMigrationFolders(migrationsPath);
  if (migrations.length > 0) {
    existingFiles.push(`Migrations: ${migrations.length} migration(s) in ${migrationsPath}`);
  }

  // If there are existing files and not using --force, ask for confirmation
  if (existingFiles.length > 0 && !ctx.options.force) {
    ctx.log("warning", "The following files/directories already exist:");
    for (const file of existingFiles) {
      ctx.log("info", `  ${file}`);
    }

    if (!ctx.promptPullConfirm) {
      throw new CommandError(
        "Existing schema/migrations found. Use --force to overwrite, or provide a prompt handler."
      );
    }

    const confirmed = await ctx.promptPullConfirm(existingFiles);
    if (!confirmed) {
      ctx.log("warning", "Aborted - no changes made");
      return;
    }
  }

  if (ctx.options.preview) {
    ctx.log("info", "Preview mode - no files will be written.");

    const result = await pullSchema({
      dialect,
      connectionUrl,
      databasePath,
      outputPath: schemaOutputPath,
      writeFile: false,
    });

    if (fs.existsSync(schemaOutputPath)) {
      const diffOutput = await buildSchemaDiff(schemaOutputPath, result.schema);
      if (diffOutput) {
        const { text, truncated } = truncateLines(diffOutput, 200);
        ctx.log("info", `Diff (existing -> generated):\n${text}`);
        if (truncated) {
          ctx.log("info", "Diff truncated. Use --output to write and inspect the full schema.");
        }
      } else {
        ctx.log("info", "Diff unavailable; showing generated schema preview.");
        const { text, truncated } = truncateLines(result.schema, 200);
        ctx.log("info", `Generated schema:\n${text}`);
        if (truncated) {
          ctx.log("info", "Preview truncated. Use --output to write and inspect the full schema.");
        }
      }
    } else {
      const { text, truncated } = truncateLines(result.schema, 200);
      ctx.log("info", `Generated schema:\n${text}`);
      if (truncated) {
        ctx.log("info", "Preview truncated. Use --output to write and inspect the full schema.");
      }
    }

    return;
  }

  ctx.log("info", "Pulling schema from database...");

  const result = await pullSchema({
    dialect,
    connectionUrl,
    databasePath,
    outputPath: schemaOutputPath,
  });

  ctx.log("success", `Schema generated: ${result.outputPath}`);
  ctx.log("info", `${result.tableCount} table(s) introspected`);
  ctx.log("info", "Next: review the schema, then run 'zenstack-kit init' to reset the snapshot.");

  // If we have existing migrations, warn about resetting
  if (snapshotExists || migrations.length > 0) {
    ctx.log("warning", "You should run 'zenstack-kit init' to reset the snapshot after reviewing the schema.");
  }
}

async function buildSchemaDiff(existingPath: string, nextSchema: string): Promise<string | null> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-pull-"));
  const nextPath = path.join(tempDir, "schema.zmodel");
  try {
    await fs.promises.writeFile(nextPath, nextSchema, "utf-8");
    try {
      return execFileSync(
        "git",
        ["diff", "--no-index", "--no-color", "--", existingPath, nextPath],
        { encoding: "utf-8" }
      );
    } catch (error) {
      const stdout = (error as { stdout?: string | Buffer }).stdout;
      if (stdout) {
        return stdout.toString();
      }
      return null;
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

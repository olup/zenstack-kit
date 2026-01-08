/**
 * CLI command tests
 *
 * Tests the command logic directly without spawning CLI processes.
 * This allows testing in non-TTY environments.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import {
  runMigrateGenerate,
  runMigrateApply,
  runInit,
  runPull,
  CommandError,
  type CommandContext,
  type LogFn,
} from "../src/cli/commands.js";

interface BaseMigrationOptions {
  migrationsFolder?: string;
  migrationsTable?: string;
}

interface SqliteConfigOptions extends BaseMigrationOptions {
  dialect?: "sqlite";
  file?: string;
}

interface PostgresConfigOptions extends BaseMigrationOptions {
  dialect: "postgres";
  url?: string;
  migrationsSchema?: string;
}

interface MysqlConfigOptions extends BaseMigrationOptions {
  dialect: "mysql";
  url?: string;
}

type ConfigOptions = SqliteConfigOptions | PostgresConfigOptions | MysqlConfigOptions;

function createConfigFile(schemaPath: string, options?: ConfigOptions): string {
  const dialect = options?.dialect ?? "sqlite";
  const migrationsFolder = options?.migrationsFolder ?? "./migrations";

  // Build dbCredentials based on dialect
  let dbCredentialsLine = "";
  if (dialect === "sqlite") {
    const sqliteOpts = options as SqliteConfigOptions | undefined;
    if (sqliteOpts?.file) {
      dbCredentialsLine = `\n  dbCredentials: { file: "${sqliteOpts.file}" },`;
    }
  } else {
    const dbOpts = options as PostgresConfigOptions | MysqlConfigOptions;
    if (dbOpts?.url) {
      dbCredentialsLine = `\n  dbCredentials: { url: "${dbOpts.url}" },`;
    }
  }

  // Build migrations config
  const migrationsLines: string[] = [`migrationsFolder: "${migrationsFolder}"`];
  if (options?.migrationsTable) {
    migrationsLines.push(`migrationsTable: "${options.migrationsTable}"`);
  }
  if (dialect === "postgres") {
    const pgOpts = options as PostgresConfigOptions;
    if (pgOpts?.migrationsSchema) {
      migrationsLines.push(`migrationsSchema: "${pgOpts.migrationsSchema}"`);
    }
  }

  return `export default {
  schema: "${schemaPath}",
  out: "./generated",
  dialect: "${dialect}",${dbCredentialsLine}
  migrations: {
    ${migrationsLines.join(",\n    ")},
  },
};
`;
}

function createValidSnapshot(): string {
  return JSON.stringify({
    version: 2,
    createdAt: new Date().toISOString(),
    schema: { tables: [] },
  });
}

function createTestContext(
  cwd: string,
  options: CommandContext["options"] = {},
): { ctx: CommandContext; logs: Array<{ type: string; message: string }> } {
  const logs: Array<{ type: string; message: string }> = [];
  const log: LogFn = (type, message) => {
    logs.push({ type, message });
  };

  const ctx: CommandContext = {
    cwd,
    options,
    log,
    promptSnapshotExists: async () => "skip",
    promptFreshInit: async () => "baseline",
  };

  return { ctx, logs };
}

describe("zenstack-kit commands", () => {
  describe("validation errors", () => {
    it("should fail migrate:generate without config file", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));

      try {
        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateGenerate(ctx)).rejects.toThrow(
          "No zenstack-kit config file found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail migrate:apply without config file", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));

      try {
        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateApply(ctx)).rejects.toThrow(
          "No zenstack-kit config file found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail init without config file", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));

      try {
        const { ctx } = createTestContext(tempDir);
        await expect(runInit(ctx)).rejects.toThrow(
          "No zenstack-kit config file found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail pull without config file", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));

      try {
        const { ctx } = createTestContext(tempDir);
        await expect(runPull(ctx)).rejects.toThrow(
          "No zenstack-kit config file found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail migrate:generate without zmodel file", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
      const configPath = path.join(tempDir, "zenstack-kit.config.mjs");

      try {
        await fs.writeFile(
          configPath,
          createConfigFile("./schema.zmodel"),
          "utf-8",
        );

        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateGenerate(ctx)).rejects.toThrow(
          "ZenStack schema file not found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail init without zmodel file", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
      const configPath = path.join(tempDir, "zenstack-kit.config.mjs");

      try {
        await fs.writeFile(
          configPath,
          createConfigFile("./schema.zmodel"),
          "utf-8",
        );

        const { ctx } = createTestContext(tempDir);
        await expect(runInit(ctx)).rejects.toThrow(
          "ZenStack schema file not found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail migrate:generate without snapshot", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
      const configPath = path.join(tempDir, "zenstack-kit.config.mjs");
      const schemaPath = path.join(tempDir, "schema.zmodel");

      const schema = `datasource db {
  provider = "sqlite"
  url      = "file:./test.db"
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id   Int    @id @default(autoincrement())
  name String
}
`;

      try {
        await fs.writeFile(
          configPath,
          createConfigFile("./schema.zmodel"),
          "utf-8",
        );
        await fs.writeFile(schemaPath, schema, "utf-8");

        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateGenerate(ctx)).rejects.toThrow(
          "No snapshot found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail migrate:apply without snapshot", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
      const configPath = path.join(tempDir, "zenstack-kit.config.mjs");

      try {
        await fs.writeFile(
          configPath,
          createConfigFile("./schema.zmodel"),
          "utf-8",
        );

        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateApply(ctx)).rejects.toThrow(
          "No snapshot found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should fail migrate:apply without migrations", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
      const configPath = path.join(tempDir, "zenstack-kit.config.mjs");
      const migrationsPath = path.join(tempDir, "migrations");
      const metaPath = path.join(migrationsPath, "meta");

      try {
        await fs.writeFile(
          configPath,
          createConfigFile("./schema.zmodel"),
          "utf-8",
        );
        // Create migrations folder with snapshot but no migrations
        await fs.mkdir(metaPath, { recursive: true });
        await fs.writeFile(
          path.join(metaPath, "_snapshot.json"),
          createValidSnapshot(),
          "utf-8",
        );

        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateApply(ctx)).rejects.toThrow(
          "No migrations found",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should require connection URL for non-sqlite dialects", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
      const configPath = path.join(tempDir, "zenstack-kit.config.mjs");
      const migrationsPath = path.join(tempDir, "migrations");
      const metaPath = path.join(migrationsPath, "meta");

      try {
        // Use postgres dialect in config without providing URL
        await fs.writeFile(
          configPath,
          createConfigFile("./schema.zmodel", { dialect: "postgres" }),
          "utf-8",
        );
        // Create migrations folder with snapshot and a migration
        await fs.mkdir(metaPath, { recursive: true });
        await fs.writeFile(
          path.join(metaPath, "_snapshot.json"),
          createValidSnapshot(),
          "utf-8",
        );
        const migrationFolder = path.join(migrationsPath, "20240101000000_init");
        await fs.mkdir(migrationFolder);
        await fs.writeFile(
          path.join(migrationFolder, "migration.sql"),
          "-- init",
          "utf-8",
        );

        const { ctx } = createTestContext(tempDir);
        await expect(runMigrateApply(ctx)).rejects.toThrow(
          "Database connection URL is required for non-sqlite dialects",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it("should generate and apply migrations", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const configPath = path.join(tempDir, "zenstack-kit.config.mjs");
    const dbPath = path.join(tempDir, "cli-test.db");

    const schema = `datasource db {
  provider = "sqlite"
  url      = "file:./test.db"
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id   Int    @id @default(autoincrement())
  name String
}
`;

    try {
      await fs.writeFile(schemaPath, schema, "utf-8");
      // Include the database URL in the config file
      await fs.writeFile(
        configPath,
        createConfigFile("./schema.zmodel", { file: dbPath }),
        "utf-8",
      );

      // First run init to create the snapshot and initial migration
      const { ctx: initCtx } = createTestContext(tempDir, { createInitial: true });
      await runInit(initCtx);

      // Then apply migrations
      const { ctx: applyCtx } = createTestContext(tempDir);
      await runMigrateApply(applyCtx);

      const sqlite = new Database(dbPath);
      const columns = sqlite.prepare("PRAGMA table_info('user')").all();
      const columnNames = columns.map((col: any) => col.name);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("name");

      sqlite.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should generate SQL for schema changes in Prisma folder format", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");
    const configPath = path.join(tempDir, "zenstack-kit.config.mjs");

    const schemaV1 = `datasource db {
  provider = "sqlite"
  url      = "file:./test.db"
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id    Int     @id @default(autoincrement())
  name  String
}
`;

    const schemaV2 = `datasource db {
  provider = "sqlite"
  url      = "file:./test.db"
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id    Int     @id @default(autoincrement())
  name  String
  email String
}
`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");
      await fs.writeFile(
        configPath,
        createConfigFile("./schema.zmodel"),
        "utf-8",
      );

      // First run init to create the snapshot (baseline only, no initial migration)
      const { ctx: initCtx } = createTestContext(tempDir, { baseline: true });
      await runInit(initCtx);

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const { ctx: generateCtx } = createTestContext(tempDir, { name: "add_email" });
      await runMigrateGenerate(generateCtx);

      // Check Prisma folder structure
      const files = await fs.readdir(migrationsPath);
      const migrationFolder = files.find((file) => file.includes("add_email"));
      if (!migrationFolder) {
        throw new Error("Expected add_email migration folder to be created");
      }

      // Check migration.sql exists in the folder
      const sqlPath = path.join(migrationsPath, migrationFolder, "migration.sql");
      const migrationContent = await fs.readFile(sqlPath, "utf-8");

      // Should contain SQL for adding email column
      expect(migrationContent).toContain("alter table");
      expect(migrationContent).toContain("add column");
      expect(migrationContent).toContain('"email"');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

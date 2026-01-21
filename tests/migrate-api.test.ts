/**
 * Tests for the high-level migrate() programmatic API
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import Database from "better-sqlite3";
import {
  migrate,
  createPrismaMigration,
  initializeSnapshot,
  previewPrismaMigrations,
} from "../src/index.js";

const TEST_DIR = path.join(process.cwd(), "tests", "migrate-api-test");
const SCHEMA_PATH = path.join(TEST_DIR, "schema.zmodel");
const MIGRATIONS_PATH = path.join(TEST_DIR, "migrations");
const DB_PATH = path.join(TEST_DIR, "test.db");
const CONFIG_PATH = path.join(TEST_DIR, "zenstack-kit.config.mjs");

async function cleanup(): Promise<void> {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore errors
  }
}

async function writeSchema(content: string): Promise<void> {
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(SCHEMA_PATH, content, "utf-8");
}

async function writeConfig(): Promise<void> {
  const config = `export default {
  schema: "./schema.zmodel",
  dialect: "sqlite",
  dbCredentials: { file: "${DB_PATH}" },
  migrations: {
    migrationsFolder: "./migrations",
  },
};
`;
  await fs.writeFile(CONFIG_PATH, config, "utf-8");
}

describe("migrate() programmatic API", () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("should apply migrations with explicit options", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id @default(autoincrement())
        email String
      }
    `);

    // Create migration manually
    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Apply using migrate() API
    const result = await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(result.mode).toBe("apply");
    if (result.mode === "apply") {
      expect(result.applied.length).toBe(1);
      expect(result.applied[0].migrationName).toContain("init");
    }

    // Verify table was created
    const db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    db.close();

    expect(tables.map((t) => t.name)).toContain("User");
  });

  it("should apply migrations using config file", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Post {
        id    Int    @id @default(autoincrement())
        title String
      }
    `);
    await writeConfig();

    // Create migration
    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Apply using migrate() with just cwd
    const result = await migrate({ cwd: TEST_DIR });

    expect(result.mode).toBe("apply");
    if (result.mode === "apply") {
      expect(result.applied.length).toBe(1);
    }

    // Verify table was created
    const db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    db.close();

    expect(tables.map((t) => t.name)).toContain("Post");
  });

  it("should preview migrations without applying", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Comment {
        id   Int    @id @default(autoincrement())
        text String
      }
    `);

    // Create migration
    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Preview using migrate() API
    const result = await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
      preview: true,
    });

    expect(result.mode).toBe("preview");
    if (result.mode === "preview") {
      expect(result.pending.length).toBe(1);
      expect(result.pending[0].name).toContain("init");
      expect(result.pending[0].sql).toContain("create table");
    }

    // Verify table was NOT created (preview mode)
    const db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    db.close();

    // Only migrations table should exist (created by preview to check status)
    expect(tables.map((t) => t.name)).not.toContain("Comment");
  });

  it("should return already applied migrations", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Tag {
        id   Int    @id @default(autoincrement())
        name String
      }
    `);

    // Create and apply migration
    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    // Try to apply again
    const result = await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(result.mode).toBe("apply");
    if (result.mode === "apply") {
      expect(result.applied.length).toBe(0);
      expect(result.alreadyApplied.length).toBe(1);
    }
  });

  it("should throw error when required options are missing", async () => {
    await expect(
      migrate({
        // No migrationsFolder, no config file
        cwd: "/nonexistent/path",
      })
    ).rejects.toThrow("migrationsFolder is required");
  });

  it("should throw error when migration fails", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Item {
        id Int @id
      }
    `);

    // Create migration
    const migration = await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Tamper with migration to make it fail
    const sqlPath = path.join(migration!.folderPath, "migration.sql");
    await fs.writeFile(sqlPath, "INVALID SQL SYNTAX HERE;", "utf-8");

    // Should throw on failure
    await expect(
      migrate({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "sqlite",
        databasePath: DB_PATH,
      })
    ).rejects.toThrow();
  });

  it("should use custom migrations table", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Category {
        id   Int    @id @default(autoincrement())
        name String
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
      migrationsTable: "custom_migrations",
    });

    // Verify custom table was created
    const db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    db.close();

    expect(tables.map((t) => t.name)).toContain("custom_migrations");
    expect(tables.map((t) => t.name)).not.toContain("_prisma_migrations");
  });
});

describe("previewPrismaMigrations()", () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("should list pending migrations", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "first",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Wait for different timestamp
    await new Promise((r) => setTimeout(r, 1100));

    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String
      }
    `);

    await createPrismaMigration({
      name: "second",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const preview = await previewPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(preview.pending.length).toBe(2);
    expect(preview.pending[0].name).toContain("first");
    expect(preview.pending[1].name).toContain("second");
    expect(preview.alreadyApplied.length).toBe(0);
  });

  it("should show SQL content for pending migrations", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Product {
        id    Int    @id @default(autoincrement())
        name  String
        price Int
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const preview = await previewPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(preview.pending.length).toBe(1);
    expect(preview.pending[0].sql).toContain("create table");
    expect(preview.pending[0].sql).toContain('"Product"');
    expect(preview.pending[0].sql).toContain('"name"');
    expect(preview.pending[0].sql).toContain('"price"');
  });

  it("should separate applied and pending migrations", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Order {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "first",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Apply first migration
    await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    // Wait for different timestamp
    await new Promise((r) => setTimeout(r, 1100));

    // Add second migration
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Order {
        id     Int    @id
        status String
      }
    `);

    await createPrismaMigration({
      name: "second",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const preview = await previewPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(preview.alreadyApplied.length).toBe(1);
    expect(preview.alreadyApplied[0]).toContain("first");
    expect(preview.pending.length).toBe(1);
    expect(preview.pending[0].name).toContain("second");
  });

  it("should return empty pending when all migrations applied", async () => {
    await writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model Invoice {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Apply all migrations
    await migrate({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    const preview = await previewPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(preview.pending.length).toBe(0);
    expect(preview.alreadyApplied.length).toBe(1);
  });
});

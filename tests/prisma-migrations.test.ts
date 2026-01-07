/**
 * Tests for Prisma-compatible migrations
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import {
  createPrismaMigration,
  applyPrismaMigrations,
  hasPrismaSchemaChanges,
} from "../src/prisma-migrations.js";

const TEST_DIR = path.join(process.cwd(), "tests", "prisma-test");
const SCHEMA_PATH = path.join(TEST_DIR, "schema.zmodel");
const MIGRATIONS_PATH = path.join(TEST_DIR, "migrations");
const DB_PATH = path.join(TEST_DIR, "test.db");

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function writeSchema(content: string): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(SCHEMA_PATH, content, "utf-8");
}

describe("Prisma migrations - SQL generation", () => {
  beforeAll(() => {
    cleanup();
  });

  afterAll(() => {
    cleanup();
  });

  beforeEach(() => {
    // Clean migrations between tests but keep dir
    if (fs.existsSync(MIGRATIONS_PATH)) {
      fs.rmSync(MIGRATIONS_PATH, { recursive: true });
    }
  });

  it("should generate SQL migration for new table", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id @default(autoincrement())
        email String @unique
        name  String?
      }
    `);

    const migration = await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();
    expect(migration!.folderName).toMatch(/^\d{14}_init$/);
    expect(migration!.sql).toContain("create table");
    expect(migration!.sql).toContain('"user"');

    // Check file was created
    const sqlPath = path.join(migration!.folderPath, "migration.sql");
    expect(fs.existsSync(sqlPath)).toBe(true);

    const sqlContent = fs.readFileSync(sqlPath, "utf-8");
    expect(sqlContent).toContain("create table");
  });

  it("should generate correct SQL for different dialects", async () => {
    writeSchema(`
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }

      model Post {
        id        Int      @id @default(autoincrement())
        title     String
        published Boolean  @default(false)
        createdAt DateTime @default(now())
      }
    `);

    const migration = await createPrismaMigration({
      name: "add_posts",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "postgres",
    });

    expect(migration).not.toBeNull();
    // PostgreSQL uses serial for autoincrement
    expect(migration!.sql).toContain("create table");
    expect(migration!.sql).toContain('"post"');
  });

  it("should detect no changes when schema unchanged", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    // First migration
    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Check for changes (should be none)
    const hasChanges = await hasPrismaSchemaChanges({
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
    });

    expect(hasChanges).toBe(false);
  });

  it("should detect changes when schema modified", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    // First migration
    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Modify schema
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String
      }
    `);

    const hasChanges = await hasPrismaSchemaChanges({
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
    });

    expect(hasChanges).toBe(true);
  });

  it("should generate add column migration", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Add column
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String
      }
    `);

    const migration = await createPrismaMigration({
      name: "add_email",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();
    expect(migration!.sql).toContain("alter table");
    expect(migration!.sql).toContain("add column");
    expect(migration!.sql).toContain('"email"');
  });
});

describe("Prisma migrations - apply", () => {
  let db: ReturnType<typeof Database> | null = null;

  beforeAll(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (db) {
      db.close();
      db = null;
    }
    cleanup();
  });

  beforeEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }
    if (fs.existsSync(MIGRATIONS_PATH)) {
      fs.rmSync(MIGRATIONS_PATH, { recursive: true });
    }
  });

  it("should apply migrations and create _prisma_migrations table", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id @default(autoincrement())
        email String
      }
    `);

    const migration = await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Debug: print generated SQL
    console.log("Generated SQL:", migration?.sql);

    const result = await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    // Debug: print result
    console.log("Apply result:", result);

    expect(result.applied.length).toBe(1);
    expect(result.applied[0].migrationName).toMatch(/^\d{14}_init$/);
    expect(result.failed).toBeUndefined();

    // Verify table was created
    db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    console.log("Tables:", tables);

    expect(tables.map((t) => t.name)).toContain("user");
    expect(tables.map((t) => t.name)).toContain("_prisma_migrations");
  });

  it("should track applied migrations and not reapply", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // First apply
    await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    // Second apply
    const result = await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(result.applied.length).toBe(0);
    expect(result.alreadyApplied.length).toBe(1);
  });

  it("should apply multiple migrations in order", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Wait a bit to ensure different timestamp
    await new Promise((r) => setTimeout(r, 1100));

    writeSchema(`
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
      name: "add_email",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const result = await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    expect(result.applied.length).toBe(2);
    expect(result.applied[0].migrationName).toContain("init");
    expect(result.applied[1].migrationName).toContain("add_email");

    // Verify schema
    db = new Database(DB_PATH);
    const columns = db.prepare("PRAGMA table_info(user)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("email");
  });

  it("should use custom migrations table name", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
      migrationsTable: "custom_migrations",
    });

    db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toContain("custom_migrations");
    expect(tables.map((t) => t.name)).not.toContain("_prisma_migrations");
  });
});

describe("Prisma migrations - folder structure", () => {
  beforeAll(() => {
    cleanup();
  });

  afterAll(() => {
    cleanup();
  });

  it("should create Prisma-compatible folder structure", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }
    `);

    const migration = await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();

    // Check folder structure
    const migrationFolder = path.join(MIGRATIONS_PATH, migration!.folderName);
    expect(fs.existsSync(migrationFolder)).toBe(true);
    expect(fs.existsSync(path.join(migrationFolder, "migration.sql"))).toBe(true);

    // Check snapshot was created
    expect(fs.existsSync(path.join(MIGRATIONS_PATH, "meta", "_snapshot.json"))).toBe(true);
  });
});

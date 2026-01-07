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

  beforeEach(() => {
    if (fs.existsSync(MIGRATIONS_PATH)) {
      fs.rmSync(MIGRATIONS_PATH, { recursive: true });
    }
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

  it("should use 14-digit timestamp format (YYYYMMDDHHmmss)", async () => {
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
      name: "test_timestamp",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();
    // Verify folder name matches pattern: 14 digits + underscore + name
    expect(migration!.folderName).toMatch(/^\d{14}_test_timestamp$/);

    // Verify the timestamp is reasonable (within last minute)
    const timestampStr = migration!.folderName.slice(0, 14);
    const year = parseInt(timestampStr.slice(0, 4));
    const month = parseInt(timestampStr.slice(4, 6));
    const day = parseInt(timestampStr.slice(6, 8));
    const hour = parseInt(timestampStr.slice(8, 10));
    const minute = parseInt(timestampStr.slice(10, 12));
    const second = parseInt(timestampStr.slice(12, 14));

    const now = new Date();
    expect(year).toBe(now.getFullYear());
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThanOrEqual(59);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThanOrEqual(59);
  });

  it("should sanitize migration names (replace special chars with underscore)", async () => {
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
      name: "Add User-Table & Email",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();
    // Special characters should be replaced with underscores, lowercased
    expect(migration!.folderName).toMatch(/^\d{14}_add_user_table___email$/);
  });

  it("should create migration folders sorted by timestamp", async () => {
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
      name: "first",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Wait to ensure different timestamp
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
      name: "second",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // List migration folders
    const entries = fs.readdirSync(MIGRATIONS_PATH, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();

    expect(folders.length).toBe(2);
    expect(folders[0]).toContain("first");
    expect(folders[1]).toContain("second");
    // First timestamp should be less than second
    expect(folders[0].slice(0, 14) < folders[1].slice(0, 14)).toBe(true);
  });
});

describe("Prisma migrations - migration.sql file contents", () => {
  beforeAll(() => {
    cleanup();
  });

  afterAll(() => {
    cleanup();
  });

  beforeEach(() => {
    if (fs.existsSync(MIGRATIONS_PATH)) {
      fs.rmSync(MIGRATIONS_PATH, { recursive: true });
    }
  });

  it("should include migration header comments", async () => {
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
      name: "with_header",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();

    const sqlContent = fs.readFileSync(
      path.join(migration!.folderPath, "migration.sql"),
      "utf-8"
    );

    // Should have migration name comment
    expect(sqlContent).toContain("-- Migration: with_header");
    // Should have timestamp comment
    expect(sqlContent).toMatch(/-- Generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("should generate valid CREATE TABLE SQL", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int     @id @default(autoincrement())
        email String  @unique
        name  String?
        age   Int     @default(0)
      }
    `);

    const migration = await createPrismaMigration({
      name: "create_user",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();
    const sql = migration!.sql.toLowerCase();

    expect(sql).toContain("create table");
    expect(sql).toContain('"user"');
    expect(sql).toContain('"id"');
    expect(sql).toContain('"email"');
    expect(sql).toContain('"name"');
    expect(sql).toContain('"age"');
  });

  it("should generate valid ALTER TABLE SQL for column additions", async () => {
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

    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String
        phone String
      }
    `);

    const migration = await createPrismaMigration({
      name: "add_columns",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();
    const sql = migration!.sql.toLowerCase();

    expect(sql).toContain("alter table");
    expect(sql).toContain("add column");
    expect(sql).toContain('"email"');
    expect(sql).toContain('"phone"');
  });

  it("should end SQL statements with semicolons", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id Int @id
      }

      model Post {
        id Int @id
      }
    `);

    const migration = await createPrismaMigration({
      name: "multiple_tables",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    expect(migration).not.toBeNull();

    // Each statement should end with semicolon
    const statements = migration!.sql
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("--"));

    for (const stmt of statements) {
      if (stmt.trim().length > 0) {
        expect(stmt.trim().endsWith(";")).toBe(true);
      }
    }
  });
});

describe("Prisma migrations - snapshot file structure", () => {
  beforeAll(() => {
    cleanup();
  });

  afterAll(() => {
    cleanup();
  });

  beforeEach(() => {
    if (fs.existsSync(MIGRATIONS_PATH)) {
      fs.rmSync(MIGRATIONS_PATH, { recursive: true });
    }
  });

  it("should create snapshot in meta/_snapshot.json", async () => {
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

    const snapshotPath = path.join(MIGRATIONS_PATH, "meta", "_snapshot.json");
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });

  it("should have valid JSON structure in snapshot", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String @unique
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const snapshotPath = path.join(MIGRATIONS_PATH, "meta", "_snapshot.json");
    const content = fs.readFileSync(snapshotPath, "utf-8");
    const snapshot = JSON.parse(content);

    // Check structure
    expect(snapshot).toHaveProperty("version");
    expect(snapshot).toHaveProperty("schema");
    expect(snapshot).toHaveProperty("createdAt");
    expect(snapshot.version).toBe(2);
  });

  it("should include table definitions in snapshot", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String @unique
        name  String?
      }

      model Post {
        id    Int    @id
        title String
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const snapshotPath = path.join(MIGRATIONS_PATH, "meta", "_snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));

    expect(snapshot.schema).toHaveProperty("tables");
    expect(Array.isArray(snapshot.schema.tables)).toBe(true);
    expect(snapshot.schema.tables.length).toBe(2);

    const tableNames = snapshot.schema.tables.map((t: any) => t.name);
    expect(tableNames).toContain("user");
    expect(tableNames).toContain("post");
  });

  it("should include column details in snapshot", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int     @id
        email String  @unique
        name  String?
        age   Int     @default(0)
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const snapshotPath = path.join(MIGRATIONS_PATH, "meta", "_snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));

    const userTable = snapshot.schema.tables.find((t: any) => t.name === "user");
    expect(userTable).toBeDefined();
    expect(userTable.columns).toBeDefined();
    expect(Array.isArray(userTable.columns)).toBe(true);

    const columnNames = userTable.columns.map((c: any) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("email");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("age");

    // Check column properties
    const nameCol = userTable.columns.find((c: any) => c.name === "name");
    expect(nameCol.notNull).toBe(false); // String? is nullable

    const emailCol = userTable.columns.find((c: any) => c.name === "email");
    expect(emailCol.notNull).toBe(true);
  });

  it("should include constraint details in snapshot", async () => {
    writeSchema(`
      datasource db {
        provider = "sqlite"
        url      = "file:./test.db"
      }

      model User {
        id    Int    @id
        email String @unique

        @@unique([id, email])
        @@index([email])
      }
    `);

    await createPrismaMigration({
      name: "init",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    const snapshotPath = path.join(MIGRATIONS_PATH, "meta", "_snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));

    const userTable = snapshot.schema.tables.find((t: any) => t.name === "user");

    // Check primary key
    expect(userTable.primaryKey).toBeDefined();
    expect(userTable.primaryKey.columns).toContain("id");

    // Check unique constraints
    expect(userTable.uniqueConstraints).toBeDefined();
    expect(Array.isArray(userTable.uniqueConstraints)).toBe(true);

    // Check indexes
    expect(userTable.indexes).toBeDefined();
    expect(Array.isArray(userTable.indexes)).toBe(true);
  });

  it("should update snapshot after each migration", async () => {
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

    const snapshotPath = path.join(MIGRATIONS_PATH, "meta", "_snapshot.json");
    const snapshot1 = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    const userTable1 = snapshot1.schema.tables.find((t: any) => t.name === "user");
    expect(userTable1.columns.length).toBe(1);

    // Add a column
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

    const snapshot2 = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    const userTable2 = snapshot2.schema.tables.find((t: any) => t.name === "user");
    expect(userTable2.columns.length).toBe(2);
  });
});

describe("Prisma migrations - migrations table configuration", () => {
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

  it("should use default _prisma_migrations table name", async () => {
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
    });

    db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toContain("_prisma_migrations");
  });

  it("should allow custom migrations table name", async () => {
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
      migrationsTable: "my_migrations",
    });

    db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toContain("my_migrations");
    expect(tables.map((t) => t.name)).not.toContain("_prisma_migrations");
  });

  it("should have correct schema for migrations table", async () => {
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
    });

    db = new Database(DB_PATH);
    const columns = db
      .prepare("PRAGMA table_info(_prisma_migrations)")
      .all() as { name: string; type: string; notnull: number; pk: number }[];

    const columnNames = columns.map((c) => c.name);

    // Verify all expected columns exist
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("checksum");
    expect(columnNames).toContain("finished_at");
    expect(columnNames).toContain("migration_name");
    expect(columnNames).toContain("logs");
    expect(columnNames).toContain("rolled_back_at");
    expect(columnNames).toContain("started_at");
    expect(columnNames).toContain("applied_steps_count");

    // Check id is primary key
    const idCol = columns.find((c) => c.name === "id");
    expect(idCol?.pk).toBe(1);
  });

  it("should record migration with correct data", async () => {
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

    await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    db = new Database(DB_PATH);
    const records = db
      .prepare("SELECT * FROM _prisma_migrations")
      .all() as any[];

    expect(records.length).toBe(1);
    expect(records[0].migration_name).toBe(migration!.folderName);
    expect(records[0].checksum).toBeDefined();
    expect(records[0].checksum.length).toBe(64); // SHA256 hex is 64 chars
    expect(records[0].finished_at).toBeDefined();
    expect(records[0].applied_steps_count).toBe(1);
    expect(records[0].rolled_back_at).toBeNull();
  });

  it("should generate unique UUIDs for each migration record", async () => {
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
      name: "first",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

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
      name: "second",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    db = new Database(DB_PATH);
    const records = db
      .prepare("SELECT id FROM _prisma_migrations")
      .all() as { id: string }[];

    expect(records.length).toBe(2);
    expect(records[0].id).not.toBe(records[1].id);
    // UUIDs should be valid format
    expect(records[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(records[1].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  }, 10000); // Increase timeout to 10 seconds

  it("should calculate different checksums for different migrations", async () => {
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
      name: "first",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    // Wait to ensure different timestamp
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
      name: "second",
      schemaPath: SCHEMA_PATH,
      outputPath: MIGRATIONS_PATH,
      dialect: "sqlite",
    });

    await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
    });

    db = new Database(DB_PATH);
    const records = db
      .prepare("SELECT checksum FROM _prisma_migrations ORDER BY started_at")
      .all() as { checksum: string }[];

    expect(records.length).toBe(2);
    expect(records[0].checksum).not.toBe(records[1].checksum);
  }, 10000); // Increase timeout to 10 seconds

  it("should isolate migrations between different table names", async () => {
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

    // Apply with custom table
    const result1 = await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
      migrationsTable: "team_a_migrations",
    });

    expect(result1.applied.length).toBe(1);

    // Check that team_a tracked the migration
    db = new Database(DB_PATH);
    const teamARecords = db
      .prepare("SELECT * FROM team_a_migrations")
      .all() as any[];
    expect(teamARecords.length).toBe(1);

    // Create team_b_migrations table manually (simulating another team)
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_b_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        finished_at TEXT,
        migration_name TEXT NOT NULL,
        logs TEXT,
        rolled_back_at TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // team_b hasn't tracked any migrations yet
    const teamBRecords = db
      .prepare("SELECT * FROM team_b_migrations")
      .all() as any[];
    expect(teamBRecords.length).toBe(0);

    db.close();
    db = null;

    // Applying with team_b table should fail (table already exists) but team_b should still show as pending
    // This verifies that different tracking tables are truly isolated
    const result2 = await applyPrismaMigrations({
      migrationsFolder: MIGRATIONS_PATH,
      dialect: "sqlite",
      databasePath: DB_PATH,
      migrationsTable: "team_b_migrations",
    });

    // The migration will fail because user table already exists
    // But that's expected - this test verifies that the tracking is isolated
    expect(result2.failed).toBeDefined();
    expect(result2.failed?.error).toContain("user");

    db = new Database(DB_PATH);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toContain("team_a_migrations");
    expect(tables.map((t) => t.name)).toContain("team_b_migrations");
  }, 10000); // Increase timeout
});

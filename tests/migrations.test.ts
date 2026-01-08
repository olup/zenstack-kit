/**
 * Tests for migration generation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMigration } from "../src/migrations/diff.js";
import { applyMigrations } from "../src/migrations/apply.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { pathToFileURL } from "url";

const FIXTURES_PATH = path.join(process.cwd(), "tests", "fixtures");
const MIGRATIONS_PATH = path.join(process.cwd(), "tests", "migrations");

describe("createMigration", () => {
  beforeEach(async () => {
    await fs.rm(MIGRATIONS_PATH, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(MIGRATIONS_PATH, { recursive: true, force: true });
  });

  it("should create a migration file", async () => {
    const migration = await createMigration({
      name: "initial",
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
      outputPath: MIGRATIONS_PATH,
    });

    if (!migration) {
      throw new Error("Expected a migration to be generated");
    }

    expect(migration.filename).toMatch(/^\d{14}_initial\.ts$/);
    expect(migration.timestamp).toBeGreaterThan(0);

    // Verify file was created
    const filePath = path.join(MIGRATIONS_PATH, migration.filename);
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("should generate CREATE TABLE statements", async () => {
    const migration = await createMigration({
      name: "create_tables",
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
      outputPath: MIGRATIONS_PATH,
    });

    if (!migration) {
      throw new Error("Expected a migration to be generated");
    }

    expect(migration.up).toContain("createTable('user')");
    expect(migration.up).toContain("createTable('post')");
    // Prisma-compatible naming: {table}_pkey, {table}_{columns}_key
    expect(migration.up).toContain("addPrimaryKeyConstraint('user_pkey'");
    expect(migration.up).toContain("addPrimaryKeyConstraint('post_pkey'");
    expect(migration.up).toContain("addUniqueConstraint('user_email_key'");
    expect(migration.up).toContain("notNull()");
  });

  it("should generate DROP TABLE statements for down migration", async () => {
    const migration = await createMigration({
      name: "drop_tables",
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
      outputPath: MIGRATIONS_PATH,
    });

    if (!migration) {
      throw new Error("Expected a migration to be generated");
    }

    expect(migration.down).toContain("dropTable('user')");
    expect(migration.down).toContain("dropTable('post')");
  });

  it("should sanitize migration name", async () => {
    const migration = await createMigration({
      name: "Add Users & Posts!",
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
      outputPath: MIGRATIONS_PATH,
    });

    if (!migration) {
      throw new Error("Expected a migration to be generated");
    }

    expect(migration.filename).toContain("add_users___posts_");
  });

  it("should include Kysely types in generated file", async () => {
    const migration = await createMigration({
      name: "with_types",
      schemaPath: path.join(FIXTURES_PATH, "schema.zmodel"),
      outputPath: MIGRATIONS_PATH,
    });

    if (!migration) {
      throw new Error("Expected a migration to be generated");
    }

    const filePath = path.join(MIGRATIONS_PATH, migration.filename);
    const content = await fs.readFile(filePath, "utf-8");

    expect(content).toContain('import type { Kysely }');
    expect(content).toContain("export async function up");
    expect(content).toContain("export async function down");
  });

  it("should generate subsequent migrations from snapshots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  name String\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  email String @unique\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "add_email",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      expect(second.up).toContain("alterTable('user')");
      expect(second.up).toContain("addColumn('email'");
      // Prisma naming: {table}_{columns}_key
      expect(second.up).toContain("addUniqueConstraint('user_email_key'");
      expect(second.up).not.toContain("createTable('user')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle column removal and nullability/default changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int     @id @default(autoincrement())\n  name  String  @default(\"anon\")\n  email String?\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  name String?\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "change_name",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      expect(second.up).toContain("dropColumn('email')");
      expect(second.up).toContain("alterColumn('name'");
      expect(second.up).toContain("dropNotNull()");
      expect(second.up).toContain("dropDefault()");
      expect(second.up).not.toContain("createTable('user')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle index and foreign key changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  posts Post[]\n}\n\nmodel Post {\n  id       Int   @id @default(autoincrement())\n  title    String\n  author   User  @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  posts Post[]\n\n  @@index([name])\n}\n\nmodel Post {\n  id       Int   @id @default(autoincrement())\n  title    String\n  author   User  @relation(fields: [authorId], references: [id])\n  authorId Int\n\n  @@index([title])\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "add_index",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      // Prisma naming: {table}_{columns}_idx
      expect(second.up).toContain("createIndex('post_title_idx')");
      expect(second.up).toContain("createIndex('user_name_idx')");
      expect(second.up).not.toContain("createTable('post')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should return null when no schema changes are detected", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schema = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  name String\n}\n`;

    try {
      await fs.writeFile(schemaPath, schema, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      const second = await createMigration({
        name: "no_changes",
        schemaPath,
        outputPath: migrationsPath,
      });

      expect(second).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should drop indexes when removed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel Post {\n  id    Int    @id @default(autoincrement())\n  title String\n\n  @@index([title])\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel Post {\n  id    Int    @id @default(autoincrement())\n  title String\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "drop_index",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      // Prisma naming: {table}_{columns}_idx
      expect(second.up).toContain("dropIndex('post_title_idx')");
      expect(second.up).not.toContain("createTable('post')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should drop composite unique constraints when removed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  email String\n\n  @@unique([name, email])\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  email String\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "drop_unique",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      // Prisma naming: {table}_{columns}_key
      expect(second.up).toContain("dropConstraint('user_name_email_key')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should update foreign keys when relation fields change", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  posts Post[]\n}\n\nmodel Post {\n  id       Int   @id @default(autoincrement())\n  title    String\n  author   User  @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  posts Post[]\n}\n\nmodel Post {\n  id       Int   @id @default(autoincrement())\n  title    String\n  editor   User  @relation(fields: [editorId], references: [id])\n  editorId Int\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "change_fk",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      // Prisma naming: {table}_{columns}_fkey
      expect(second.up).toContain("dropConstraint('post_authorId_fkey')");
      expect(second.up).toContain("addForeignKeyConstraint('post_editorId_fkey'");
      expect(second.up).toContain("addColumn('editorId'");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should update primary key constraints when model @@id changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  org  String\n  name String\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @default(autoincrement())\n  org  String\n  name String\n\n  @@id([org, name])\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "pk_change",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      // Prisma naming: {table}_pkey
      expect(second.up).toContain("dropConstraint('user_pkey')");
      expect(second.up).toContain("addPrimaryKeyConstraint('user_pkey'");
      expect(second.up).toContain("[\"org\",\"name\"]");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle multi-column index changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  email String\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  name  String\n  email String\n\n  @@index([name, email])\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      const first = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!first) {
        throw new Error("Expected initial migration to be generated");
      }

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const second = await createMigration({
        name: "add_multi_index",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!second) {
        throw new Error("Expected second migration to be generated");
      }

      // Prisma naming: {table}_{columns}_idx
      expect(second.up).toContain("createIndex('user_name_email_idx')");
      expect(second.up).toContain(".column('name')");
      expect(second.up).toContain(".column('email')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should apply generated migration and match sqlite schema", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");
    const dbPath = path.join(tempDir, "test.db");

    const schema = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int     @id @default(autoincrement())\n  email String  @unique\n  name  String\n  posts Post[]\n}\n\nmodel Post {\n  id       Int   @id @default(autoincrement())\n  title    String\n  author   User  @relation(fields: [authorId], references: [id])\n  authorId Int\n\n  @@index([title])\n}\n`;

    let db: Kysely<any> | null = null;
    let sqlite: any = null;

    try {
      await fs.writeFile(schemaPath, schema, "utf-8");

      const migration = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!migration) {
        throw new Error("Expected migration to be generated");
      }

      const migrationPath = path.join(migrationsPath, migration.filename);
      const migrationModule = await import(pathToFileURL(migrationPath).href);

      sqlite = new Database(dbPath);
      db = new Kysely({
        dialect: new SqliteDialect({ database: sqlite }),
      });

      await migrationModule.up(db);

      const userColumnsResult = await db.executeQuery(sql`PRAGMA table_info('user')`.compile(db));
      const userColumns = userColumnsResult.rows.map((row: any) => row.name);

      expect(userColumns).toContain("id");
      expect(userColumns).toContain("email");
      expect(userColumns).toContain("name");

      const postColumnsResult = await db.executeQuery(sql`PRAGMA table_info('post')`.compile(db));
      const postColumns = postColumnsResult.rows.map((row: any) => row.name);

      expect(postColumns).toContain("id");
      expect(postColumns).toContain("title");
      expect(postColumns).toContain("authorId");

      const userIndexes = await db.executeQuery(sql`PRAGMA index_list('user')`.compile(db));
      const uniqueIndex = userIndexes.rows.find((row: any) => row.unique === 1) as { name: string } | undefined;
      expect(uniqueIndex).toBeTruthy();

      const uniqueIndexInfo = await db.executeQuery(
        sql.raw(`PRAGMA index_info('${uniqueIndex?.name ?? ""}')`).compile(db),
      );
      const uniqueIndexColumns = uniqueIndexInfo.rows.map((row: any) => row.name);
      expect(uniqueIndexColumns).toContain("email");

      const postIndexes = await db.executeQuery(sql`PRAGMA index_list('post')`.compile(db));
      const postIndexNames = postIndexes.rows.map((row: any) => row.name);
      // Prisma naming: {table}_{columns}_idx
      expect(postIndexNames).toContain("post_title_idx");

      const foreignKeys = await db.executeQuery(sql`PRAGMA foreign_key_list('post')`.compile(db));
      const fkTables = foreignKeys.rows.map((row: any) => row.table);
      expect(fkTables).toContain("user");
    } finally {
      if (db) {
        await db.destroy();
      }
      if (sqlite) {
        sqlite.close();
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should apply migrations via migrator helper", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");
    const dbPath = path.join(tempDir, "apply-test.db");

    const schema = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  name String\n}\n`;

    try {
      await fs.writeFile(schemaPath, schema, "utf-8");

      const migration = await createMigration({
        name: "initial",
        schemaPath,
        outputPath: migrationsPath,
      });

      if (!migration) {
        throw new Error("Expected migration to be generated");
      }

      const result = await applyMigrations({
        migrationsFolder: migrationsPath,
        dialect: "sqlite",
        connectionUrl: dbPath,
      });

      expect(result.results.length).toBeGreaterThan(0);

      const sqlite = new Database(dbPath);
      const db = new Kysely({
        dialect: new SqliteDialect({ database: sqlite }),
      });

      const userColumnsResult = await db.executeQuery(sql`PRAGMA table_info('user')`.compile(db));
      const userColumns = userColumnsResult.rows.map((row: any) => row.name);

      expect(userColumns).toContain("id");
      expect(userColumns).toContain("name");

      await db.destroy();
      sqlite.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

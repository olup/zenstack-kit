/**
 * PostgreSQL-specific tests using testcontainers
 *
 * These tests verify:
 * - Basic PostgreSQL migrations
 * - Enum types
 * - Array of enums
 * - JSON/JSONB fields
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import {
  startPostgresContainer,
  stopPostgresContainer,
  cleanDatabase,
  type PostgresTestContext,
} from "./postgres-testcontainer.js";
import {
  createPrismaMigration,
  applyPrismaMigrations,
  hasPrismaSchemaChanges,
  createInitialMigration,
} from "../src/migrations/prisma.js";

const TEST_DIR = path.join(process.cwd(), "tests", "postgres-test");
const SCHEMA_PATH = path.join(TEST_DIR, "schema.zmodel");
const MIGRATIONS_PATH = path.join(TEST_DIR, "migrations");

let pgContext: PostgresTestContext;

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function writeSchema(content: string): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(SCHEMA_PATH, content, "utf-8");
}

describe("PostgreSQL migrations with testcontainers", () => {
  beforeAll(async () => {
    cleanup();
    pgContext = await startPostgresContainer();
  }, 60000); // 60s timeout for container startup

  afterAll(async () => {
    cleanup();
    await stopPostgresContainer();
  }, 30000);

  beforeEach(async () => {
    // Clean migrations folder
    if (fs.existsSync(MIGRATIONS_PATH)) {
      fs.rmSync(MIGRATIONS_PATH, { recursive: true });
    }
    // Clean database
    await cleanDatabase(pgContext.pool);
  });

  describe("Basic PostgreSQL operations", () => {
    it("should generate and apply PostgreSQL migration for new table", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
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
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain("create table");
      expect(migration!.sql).toContain('"User"');

      // Apply migration
      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify table was created
      const tables = await pgContext.pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      const tableNames = tables.rows.map((r: any) => r.table_name);
      expect(tableNames).toContain("User");
      expect(tableNames).toContain("_prisma_migrations");
    });

    it("should apply multiple migrations in order", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model User {
          id Int @id
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await new Promise((r) => setTimeout(r, 1100));

      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
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
        dialect: "postgres",
      });

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(2);
      expect(result.applied[0].migrationName).toContain("init");
      expect(result.applied[1].migrationName).toContain("add_email");

      // Verify column exists
      const columns = await pgContext.pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'User'
      `);
      const columnNames = columns.rows.map((r: any) => r.column_name);
      expect(columnNames).toContain("email");
    });
  });

  describe("Enum types", () => {
    it("should create native PostgreSQL enum type", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
          MODERATOR
        }

        model User {
          id   Int    @id @default(autoincrement())
          name String
          role Role   @default(USER)
        }
      `);

      const migration = await createPrismaMigration({
        name: "init_with_enum",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      // Verify CREATE TYPE statement is generated
      expect(migration!.sql).toContain('CREATE TYPE "Role" AS ENUM');
      expect(migration!.sql).toContain("'USER'");
      expect(migration!.sql).toContain("'ADMIN'");
      expect(migration!.sql).toContain("'MODERATOR'");

      // Apply migration
      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify enum type was created in PostgreSQL
      const enumTypes = await pgContext.pool.query(`
        SELECT t.typname as enum_name, e.enumlabel as enum_value
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        ORDER BY t.typname, e.enumsortorder
      `);

      const roleValues = enumTypes.rows
        .filter((r: any) => r.enum_name === "Role")
        .map((r: any) => r.enum_value);
      expect(roleValues).toEqual(["USER", "ADMIN", "MODERATOR"]);

      // Verify column uses the enum type
      const columns = await pgContext.pool.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'User'
      `);

      const roleColumn = columns.rows.find((r: any) => r.column_name === "role");
      expect(roleColumn).toBeDefined();
      expect(roleColumn.udt_name).toBe("Role");

      // Insert and query to verify it works
      await pgContext.pool.query(`
        INSERT INTO "User" (name, role) VALUES ('Test User', 'ADMIN')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows.length).toBe(1);
      expect(users.rows[0].role).toBe("ADMIN");

      // Verify invalid enum values are rejected
      await expect(
        pgContext.pool.query(`INSERT INTO "User" (name, role) VALUES ('Bad User', 'INVALID')`)
      ).rejects.toThrow();
    });

    it("should handle multiple enum types", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        enum Status {
          ACTIVE
          INACTIVE
          PENDING
        }

        model User {
          id     Int    @id @default(autoincrement())
          role   Role   @default(USER)
          status Status @default(PENDING)
        }
      `);

      const migration = await createPrismaMigration({
        name: "multiple_enums",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain('CREATE TYPE "Role" AS ENUM');
      expect(migration!.sql).toContain('CREATE TYPE "Status" AS ENUM');

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify both enum types were created
      const enumTypes = await pgContext.pool.query(`
        SELECT DISTINCT typname FROM pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'
      `);
      const enumNames = enumTypes.rows.map((r: any) => r.typname);
      expect(enumNames).toContain("Role");
      expect(enumNames).toContain("Status");

      // Insert and verify
      await pgContext.pool.query(`
        INSERT INTO "User" (role, status) VALUES ('ADMIN', 'ACTIVE')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].role).toBe("ADMIN");
      expect(users.rows[0].status).toBe("ACTIVE");
    });

    it("should add new values to existing enum", async () => {
      // First migration: create enum with initial values
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        model User {
          id   Int  @id @default(autoincrement())
          role Role @default(USER)
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Wait to ensure different timestamp
      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: add new enum values
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
          MODERATOR
          SUPERADMIN
        }

        model User {
          id   Int  @id @default(autoincrement())
          role Role @default(USER)
        }
      `);

      const migration = await createPrismaMigration({
        name: "add_enum_values",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain('ALTER TYPE "Role" ADD VALUE');
      expect(migration!.sql).toContain("'MODERATOR'");
      expect(migration!.sql).toContain("'SUPERADMIN'");

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify new enum values exist
      const enumValues = await pgContext.pool.query(`
        SELECT e.enumlabel as enum_value
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'Role'
        ORDER BY e.enumsortorder
      `);
      const values = enumValues.rows.map((r: any) => r.enum_value);
      expect(values).toContain("USER");
      expect(values).toContain("ADMIN");
      expect(values).toContain("MODERATOR");
      expect(values).toContain("SUPERADMIN");

      // Verify we can use the new values
      await pgContext.pool.query(`
        INSERT INTO "User" (role) VALUES ('MODERATOR')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].role).toBe("MODERATOR");
    });

    it("should warn when removing enum values", async () => {
      // First migration: create enum with values
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
          MODERATOR
          DEPRECATED_ROLE
        }

        model User {
          id   Int  @id @default(autoincrement())
          role Role @default(USER)
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: remove an enum value
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
          MODERATOR
        }

        model User {
          id   Int  @id @default(autoincrement())
          role Role @default(USER)
        }
      `);

      const migration = await createPrismaMigration({
        name: "remove_enum_value",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      // Should contain a warning comment about manual migration needed
      expect(migration!.sql).toContain("WARNING");
      expect(migration!.sql).toContain("DEPRECATED_ROLE");
      expect(migration!.sql).toContain("requires manual migration");
    });

    it("should drop enum type when no longer used", async () => {
      // First migration: create enum
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        enum Status {
          ACTIVE
          INACTIVE
        }

        model User {
          id     Int    @id @default(autoincrement())
          role   Role   @default(USER)
          status Status @default(ACTIVE)
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: remove Status enum entirely
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        model User {
          id   Int  @id @default(autoincrement())
          role Role @default(USER)
        }
      `);

      const migration = await createPrismaMigration({
        name: "remove_status_enum",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain('DROP TYPE IF EXISTS "Status"');

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify Status enum was dropped
      const enumTypes = await pgContext.pool.query(`
        SELECT DISTINCT typname FROM pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'
      `);
      const enumNames = enumTypes.rows.map((r: any) => r.typname);
      expect(enumNames).toContain("Role");
      expect(enumNames).not.toContain("Status");
    });

    it("should create new enum in subsequent migration", async () => {
      // First migration: model without enum
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model User {
          id   Int    @id @default(autoincrement())
          name String
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: add enum and use it
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        model User {
          id   Int    @id @default(autoincrement())
          name String
          role Role?
        }
      `);

      const migration = await createPrismaMigration({
        name: "add_role_enum",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain('CREATE TYPE "Role" AS ENUM');
      expect(migration!.sql).toContain('alter table "User" add column "role"');

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify enum was created and can be used
      await pgContext.pool.query(`
        INSERT INTO "User" (name, role) VALUES ('Test', 'ADMIN')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].role).toBe("ADMIN");
    });

    it("should handle enum with default value", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Priority {
          LOW
          MEDIUM
          HIGH
          CRITICAL
        }

        model Task {
          id       Int      @id @default(autoincrement())
          title    String
          priority Priority @default(MEDIUM)
        }
      `);

      const migration = await createPrismaMigration({
        name: "enum_with_default",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Insert without specifying priority - should use default
      await pgContext.pool.query(`
        INSERT INTO "Task" (title) VALUES ('Test Task')
      `);
      const tasks = await pgContext.pool.query(`SELECT * FROM "Task"`);
      expect(tasks.rows[0].priority).toBe("MEDIUM");
    });

    it("should handle enum arrays", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Permission {
          READ
          WRITE
          DELETE
          ADMIN
        }

        model User {
          id          Int          @id @default(autoincrement())
          name        String
          permissions Permission[]
        }
      `);

      const migration = await createPrismaMigration({
        name: "enum_array",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain('CREATE TYPE "Permission" AS ENUM');
      // Should use array type
      expect(migration!.sql).toMatch(/"Permission"\[\]/);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify array of enums works
      await pgContext.pool.query(`
        INSERT INTO "User" (name, permissions)
        VALUES ('Admin User', ARRAY['READ', 'WRITE', 'ADMIN']::"Permission"[])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      // pg driver returns enum arrays as strings like "{READ,WRITE,ADMIN}"
      // so we parse it or check the string representation
      const permissions = users.rows[0].permissions;
      if (typeof permissions === "string") {
        expect(permissions).toBe("{READ,WRITE,ADMIN}");
      } else {
        expect(permissions).toEqual(["READ", "WRITE", "ADMIN"]);
      }
    });

    it("should handle enum used in multiple models", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Status {
          DRAFT
          PUBLISHED
          ARCHIVED
        }

        model Post {
          id     Int    @id @default(autoincrement())
          title  String
          status Status @default(DRAFT)
        }

        model Comment {
          id     Int    @id @default(autoincrement())
          text   String
          status Status @default(DRAFT)
        }
      `);

      const migration = await createPrismaMigration({
        name: "shared_enum",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      // Should only create the enum once
      const createTypeCount = (migration!.sql.match(/CREATE TYPE "Status"/g) || []).length;
      expect(createTypeCount).toBe(1);

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Both tables should use the same enum type
      await pgContext.pool.query(`INSERT INTO "Post" (title, status) VALUES ('Test', 'PUBLISHED')`);
      await pgContext.pool.query(`INSERT INTO "Comment" (text, status) VALUES ('Test', 'ARCHIVED')`);

      const posts = await pgContext.pool.query(`SELECT status FROM "Post"`);
      const comments = await pgContext.pool.query(`SELECT status FROM "Comment"`);
      expect(posts.rows[0].status).toBe("PUBLISHED");
      expect(comments.rows[0].status).toBe("ARCHIVED");
    });

    it("should preserve existing rows when adding enum values", async () => {
      // First migration: create enum and insert data
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Status {
          ACTIVE
          INACTIVE
        }

        model User {
          id     Int    @id @default(autoincrement())
          name   String
          status Status @default(ACTIVE)
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Insert some data with existing enum values
      await pgContext.pool.query(`INSERT INTO "User" (name, status) VALUES ('Alice', 'ACTIVE')`);
      await pgContext.pool.query(`INSERT INTO "User" (name, status) VALUES ('Bob', 'INACTIVE')`);

      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: add new enum value
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Status {
          ACTIVE
          INACTIVE
          PENDING
          SUSPENDED
        }

        model User {
          id     Int    @id @default(autoincrement())
          name   String
          status Status @default(ACTIVE)
        }
      `);

      const migration = await createPrismaMigration({
        name: "add_status_values",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Verify existing data is preserved
      const users = await pgContext.pool.query(`SELECT name, status FROM "User" ORDER BY id`);
      expect(users.rows.length).toBe(2);
      expect(users.rows[0].name).toBe("Alice");
      expect(users.rows[0].status).toBe("ACTIVE");
      expect(users.rows[1].name).toBe("Bob");
      expect(users.rows[1].status).toBe("INACTIVE");

      // Verify we can use new values
      await pgContext.pool.query(`INSERT INTO "User" (name, status) VALUES ('Charlie', 'PENDING')`);
      await pgContext.pool.query(`UPDATE "User" SET status = 'SUSPENDED' WHERE name = 'Bob'`);

      const updatedUsers = await pgContext.pool.query(`SELECT name, status FROM "User" ORDER BY id`);
      expect(updatedUsers.rows[1].status).toBe("SUSPENDED");
      expect(updatedUsers.rows[2].status).toBe("PENDING");
    });

    it("should handle enum array columns with existing data", async () => {
      // First migration: create enum array
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Tag {
          TECH
          BUSINESS
          SCIENCE
        }

        model Article {
          id   Int   @id @default(autoincrement())
          tags Tag[]
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Insert data with enum arrays
      await pgContext.pool.query(`
        INSERT INTO "Article" (tags) VALUES (ARRAY['TECH', 'SCIENCE']::"Tag"[])
      `);
      await pgContext.pool.query(`
        INSERT INTO "Article" (tags) VALUES (ARRAY['BUSINESS']::"Tag"[])
      `);

      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: add new enum value
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Tag {
          TECH
          BUSINESS
          SCIENCE
          HEALTH
          SPORTS
        }

        model Article {
          id   Int   @id @default(autoincrement())
          tags Tag[]
        }
      `);

      await createPrismaMigration({
        name: "add_tags",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Verify existing array data is preserved
      const articles = await pgContext.pool.query(`SELECT tags FROM "Article" ORDER BY id`);
      expect(articles.rows.length).toBe(2);
      // Arrays come back as strings like "{TECH,SCIENCE}"
      expect(articles.rows[0].tags).toMatch(/TECH/);
      expect(articles.rows[0].tags).toMatch(/SCIENCE/);
      expect(articles.rows[1].tags).toMatch(/BUSINESS/);

      // Verify we can use new values in arrays
      await pgContext.pool.query(`
        INSERT INTO "Article" (tags) VALUES (ARRAY['HEALTH', 'SPORTS', 'TECH']::"Tag"[])
      `);
      const newArticle = await pgContext.pool.query(`SELECT tags FROM "Article" WHERE id = 3`);
      expect(newArticle.rows[0].tags).toMatch(/HEALTH/);
      expect(newArticle.rows[0].tags).toMatch(/SPORTS/);
    });

    it("should detect when rows exist with value being removed", async () => {
      // First migration: create enum with values
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Priority {
          LOW
          MEDIUM
          HIGH
          CRITICAL
        }

        model Task {
          id       Int      @id @default(autoincrement())
          title    String
          priority Priority @default(MEDIUM)
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Insert data using the value we'll try to remove
      await pgContext.pool.query(`INSERT INTO "Task" (title, priority) VALUES ('Urgent', 'CRITICAL')`);
      await pgContext.pool.query(`INSERT INTO "Task" (title, priority) VALUES ('Normal', 'MEDIUM')`);

      await new Promise((r) => setTimeout(r, 1100));

      // Second migration: try to remove CRITICAL value
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Priority {
          LOW
          MEDIUM
          HIGH
        }

        model Task {
          id       Int      @id @default(autoincrement())
          title    String
          priority Priority @default(MEDIUM)
        }
      `);

      const migration = await createPrismaMigration({
        name: "remove_critical",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      // Should generate a warning about the removed value
      expect(migration).not.toBeNull();
      expect(migration!.sql).toContain("WARNING");
      expect(migration!.sql).toContain("CRITICAL");

      // The data with CRITICAL should still be queryable
      // (migration only warns, doesn't actually remove the enum value)
      const tasks = await pgContext.pool.query(`SELECT title, priority FROM "Task" ORDER BY id`);
      expect(tasks.rows[0].priority).toBe("CRITICAL");
      expect(tasks.rows[1].priority).toBe("MEDIUM");
    });

    it("should handle optional enum fields", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Category {
          WORK
          PERSONAL
          OTHER
        }

        model Note {
          id       Int       @id @default(autoincrement())
          text     String
          category Category?
        }
      `);

      const migration = await createPrismaMigration({
        name: "optional_enum",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();

      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Insert with null category
      await pgContext.pool.query(`INSERT INTO "Note" (text) VALUES ('No category')`);
      // Insert with category
      await pgContext.pool.query(`INSERT INTO "Note" (text, category) VALUES ('Work note', 'WORK')`);

      const notes = await pgContext.pool.query(`SELECT text, category FROM "Note" ORDER BY id`);
      expect(notes.rows[0].category).toBeNull();
      expect(notes.rows[1].category).toBe("WORK");
    });
  });

  describe("JSON fields", () => {
    it("should handle JSON fields", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model User {
          id       Int    @id @default(autoincrement())
          name     String
          metadata Json?
        }
      `);

      const migration = await createPrismaMigration({
        name: "init_with_json",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      console.log("Generated SQL with JSON:", migration!.sql);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify JSON column works
      await pgContext.pool.query(`
        INSERT INTO "User" (name, metadata) VALUES ('Test', '{"key": "value", "nested": {"a": 1}}')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].metadata).toEqual({ key: "value", nested: { a: 1 } });
    });

    it("should handle required JSON fields", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model Config {
          id       Int  @id @default(autoincrement())
          settings Json
        }
      `);

      const migration = await createPrismaMigration({
        name: "required_json",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify NOT NULL constraint
      const columns = await pgContext.pool.query(`
        SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Config'
      `);

      const settingsColumn = columns.rows.find((r: any) => r.column_name === "settings");
      expect(settingsColumn).toBeDefined();
      expect(settingsColumn.is_nullable).toBe("NO");
    });
  });

  describe("Array types", () => {
    it("should handle string arrays", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model User {
          id   Int      @id @default(autoincrement())
          name String
          tags String[]
        }
      `);

      const migration = await createPrismaMigration({
        name: "string_array",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      console.log("Generated SQL with string array:", migration!.sql);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify array works
      await pgContext.pool.query(`
        INSERT INTO "User" (name, tags) VALUES ('Test', ARRAY['tag1', 'tag2', 'tag3'])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].tags).toEqual(["tag1", "tag2", "tag3"]);
    });

    it("should handle integer arrays", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model User {
          id     Int   @id @default(autoincrement())
          scores Int[]
        }
      `);

      const migration = await createPrismaMigration({
        name: "int_array",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      console.log("Generated SQL with int array:", migration!.sql);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify array works
      await pgContext.pool.query(`
        INSERT INTO "User" (scores) VALUES (ARRAY[10, 20, 30])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].scores).toEqual([10, 20, 30]);
    });

    it("should handle enum arrays", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Permission {
          READ
          WRITE
          DELETE
          ADMIN
        }

        model User {
          id          Int          @id @default(autoincrement())
          name        String
          permissions Permission[]
        }
      `);

      const migration = await createPrismaMigration({
        name: "enum_array",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      console.log("Generated SQL with enum array:", migration!.sql);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify array works - use proper enum array cast
      await pgContext.pool.query(`
        INSERT INTO "User" (name, permissions) VALUES ('Admin', ARRAY['READ', 'WRITE', 'ADMIN']::"Permission"[])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      // pg driver returns enum arrays as strings like "{READ,WRITE,ADMIN}"
      const permissions = users.rows[0].permissions;
      if (typeof permissions === "string") {
        expect(permissions).toBe("{READ,WRITE,ADMIN}");
      } else {
        expect(permissions).toEqual(["READ", "WRITE", "ADMIN"]);
      }
    });
  });

  describe("Complex schemas", () => {
    it("should handle a complex schema with enums, arrays, JSON, and relations", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
          MODERATOR
        }

        enum PostStatus {
          DRAFT
          PUBLISHED
          ARCHIVED
        }

        model User {
          id          Int      @id @default(autoincrement())
          email       String   @unique
          name        String?
          role        Role     @default(USER)
          tags        String[]
          preferences Json?
          posts       Post[]
          createdAt   DateTime @default(now())
        }

        model Post {
          id        Int        @id @default(autoincrement())
          title     String
          content   String?
          status    PostStatus @default(DRAFT)
          metadata  Json?
          tags      String[]
          authorId  Int
          author    User       @relation(fields: [authorId], references: [id])
          createdAt DateTime   @default(now())
        }
      `);

      const migration = await createPrismaMigration({
        name: "complex_schema",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      console.log("Generated SQL for complex schema:", migration!.sql);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify tables were created
      const tables = await pgContext.pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      const tableNames = tables.rows.map((r: any) => r.table_name);
      expect(tableNames).toContain("User");
      expect(tableNames).toContain("Post");

      // Insert test data
      await pgContext.pool.query(`
        INSERT INTO "User" (email, name, role, tags, preferences)
        VALUES ('test@example.com', 'Test User', 'ADMIN', ARRAY['developer', 'writer'], '{"theme": "dark"}')
      `);

      await pgContext.pool.query(`
        INSERT INTO "Post" (title, content, status, metadata, tags, "authorId")
        VALUES ('Hello World', 'Content here', 'PUBLISHED', '{"views": 100}', ARRAY['tech', 'tutorial'], 1)
      `);

      // Verify data
      const users = await pgContext.pool.query(`SELECT * FROM "User"`);
      expect(users.rows[0].email).toBe("test@example.com");
      expect(users.rows[0].role).toBe("ADMIN");
      expect(users.rows[0].tags).toEqual(["developer", "writer"]);
      expect(users.rows[0].preferences).toEqual({ theme: "dark" });

      const posts = await pgContext.pool.query(`SELECT * FROM "Post"`);
      expect(posts.rows[0].title).toBe("Hello World");
      expect(posts.rows[0].status).toBe("PUBLISHED");
      expect(posts.rows[0].metadata).toEqual({ views: 100 });
      expect(posts.rows[0].tags).toEqual(["tech", "tutorial"]);
    });

    it("should detect schema changes for complex schema", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        model User {
          id   Int    @id
          role Role
        }
      `);

      await createPrismaMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      // Check no changes after creation
      let hasChanges = await hasPrismaSchemaChanges({
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
      });
      expect(hasChanges).toBe(false);

      // Add a new field
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        enum Role {
          USER
          ADMIN
        }

        model User {
          id    Int    @id
          role  Role
          email String
        }
      `);

      hasChanges = await hasPrismaSchemaChanges({
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
      });
      expect(hasChanges).toBe(true);
    });
  });

  describe("PostgreSQL-specific features", () => {
    it("should handle DateTime with timezone", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model Event {
          id        Int      @id @default(autoincrement())
          name      String
          startTime DateTime @default(now())
          endTime   DateTime?
        }
      `);

      const migration = await createPrismaMigration({
        name: "datetime_test",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify timestamp works
      await pgContext.pool.query(`
        INSERT INTO "Event" (name, "endTime")
        VALUES ('Test Event', '2024-12-31 23:59:59+00')
      `);

      const events = await pgContext.pool.query(`SELECT * FROM "Event"`);
      expect(events.rows[0].name).toBe("Test Event");
      expect(events.rows[0]["startTime"]).toBeInstanceOf(Date);
    });

    it("should handle BigInt fields", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model Counter {
          id    Int    @id @default(autoincrement())
          value BigInt
        }
      `);

      const migration = await createPrismaMigration({
        name: "bigint_test",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql.toLowerCase()).toContain("bigint");

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify bigint works
      await pgContext.pool.query(`
        INSERT INTO "Counter" (value) VALUES (9223372036854775807)
      `);

      const counters = await pgContext.pool.query(`SELECT * FROM "Counter"`);
      // pg returns bigint as string by default
      expect(counters.rows[0].value).toBe("9223372036854775807");
    });

    it("should handle Decimal fields", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model Price {
          id     Int     @id @default(autoincrement())
          amount Decimal
        }
      `);

      const migration = await createPrismaMigration({
        name: "decimal_test",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();
      expect(migration!.sql.toLowerCase()).toContain("decimal");

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify decimal works
      await pgContext.pool.query(`
        INSERT INTO "Price" (amount) VALUES (123.45)
      `);

      const prices = await pgContext.pool.query(`SELECT * FROM "Price"`);
      expect(prices.rows[0].amount).toBe("123.45");
    });

    it("should handle Float fields", async () => {
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model Measurement {
          id    Int   @id @default(autoincrement())
          value Float
        }
      `);

      const migration = await createPrismaMigration({
        name: "float_test",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      expect(migration).not.toBeNull();

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify float works
      await pgContext.pool.query(`
        INSERT INTO "Measurement" (value) VALUES (3.14159)
      `);

      const measurements = await pgContext.pool.query(`SELECT * FROM "Measurement"`);
      expect(measurements.rows[0].value).toBeCloseTo(3.14159);
    });
  });

  describe("Transaction support", () => {
    it("should rollback entire migration on failure", async () => {
      // Create a valid migration first
      writeSchema(`
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model User {
          id   Int    @id @default(autoincrement())
          name String
        }
      `);

      await createInitialMigration({
        name: "init",
        schemaPath: SCHEMA_PATH,
        outputPath: MIGRATIONS_PATH,
        dialect: "postgres",
      });

      // Apply the first migration
      await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      // Now create a migration with intentional failure (second statement fails)
      const badMigrationFolder = path.join(MIGRATIONS_PATH, "20990101000000_bad_migration");
      fs.mkdirSync(badMigrationFolder, { recursive: true });

      // First statement will succeed, second will fail due to syntax error
      // If not wrapped in a transaction, the first table would remain
      const badSql = `
-- Migration: bad_migration
-- This migration should fail and rollback completely

CREATE TABLE "test_table" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL
);

-- This will fail - invalid syntax
CREATE TABLE "another_table" (
  "id" SERIAL PRIMARY KEY,
  INVALID SYNTAX HERE
);
`;
      fs.writeFileSync(path.join(badMigrationFolder, "migration.sql"), badSql, "utf-8");

      // Update migration log
      const logPath = path.join(MIGRATIONS_PATH, "meta", "_migration_log");
      const existingLog = fs.readFileSync(logPath, "utf-8");
      const checksum = require("crypto").createHash("sha256").update(badSql).digest("hex");
      fs.writeFileSync(logPath, existingLog + `20990101000000_bad_migration ${checksum}\n`, "utf-8");

      // Apply migrations - should fail
      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.failed).toBeDefined();
      expect(result.failed?.migrationName).toBe("20990101000000_bad_migration");

      // Verify test_table was NOT created (rolled back)
      const tables = await pgContext.pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      const tableNames = tables.rows.map((r: any) => r.table_name);

      // test_table should NOT exist because the entire transaction was rolled back
      expect(tableNames).not.toContain("test_table");

      // User table from first migration should still exist
      expect(tableNames).toContain("User");
    });
  });
});

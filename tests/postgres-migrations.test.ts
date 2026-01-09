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
      expect(migration!.sql).toContain('"user"');

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
      expect(tableNames).toContain("user");
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
        WHERE table_schema = 'public' AND table_name = 'user'
      `);
      const columnNames = columns.rows.map((r: any) => r.column_name);
      expect(columnNames).toContain("email");
    });
  });

  describe("Enum types", () => {
    it("should handle enum fields", async () => {
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
      console.log("Generated SQL with enum:", migration!.sql);

      // Apply migration
      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Verify enum type was created or text type is used
      const columns = await pgContext.pool.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user'
      `);

      const roleColumn = columns.rows.find((r: any) => r.column_name === "role");
      expect(roleColumn).toBeDefined();
      console.log("Role column type:", roleColumn);

      // Insert and query to verify it works
      await pgContext.pool.query(`
        INSERT INTO "user" (name, role) VALUES ('Test User', 'ADMIN')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
      expect(users.rows.length).toBe(1);
      expect(users.rows[0].role).toBe("ADMIN");
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
      console.log("Generated SQL with multiple enums:", migration!.sql);

      const result = await applyPrismaMigrations({
        migrationsFolder: MIGRATIONS_PATH,
        dialect: "postgres",
        connectionUrl: pgContext.connectionUrl,
      });

      expect(result.applied.length).toBe(1);
      expect(result.failed).toBeUndefined();

      // Insert and verify
      await pgContext.pool.query(`
        INSERT INTO "user" (role, status) VALUES ('ADMIN', 'ACTIVE')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
      expect(users.rows[0].role).toBe("ADMIN");
      expect(users.rows[0].status).toBe("ACTIVE");
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
        INSERT INTO "user" (name, metadata) VALUES ('Test', '{"key": "value", "nested": {"a": 1}}')
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
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
        WHERE table_schema = 'public' AND table_name = 'config'
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
        INSERT INTO "user" (name, tags) VALUES ('Test', ARRAY['tag1', 'tag2', 'tag3'])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
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
        INSERT INTO "user" (scores) VALUES (ARRAY[10, 20, 30])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
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

      // Verify array works
      await pgContext.pool.query(`
        INSERT INTO "user" (name, permissions) VALUES ('Admin', ARRAY['READ', 'WRITE', 'ADMIN']::text[])
      `);
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
      expect(users.rows[0].permissions).toEqual(["READ", "WRITE", "ADMIN"]);
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
      expect(tableNames).toContain("user");
      expect(tableNames).toContain("post");

      // Insert test data
      await pgContext.pool.query(`
        INSERT INTO "user" (email, name, role, tags, preferences)
        VALUES ('test@example.com', 'Test User', 'ADMIN', ARRAY['developer', 'writer'], '{"theme": "dark"}')
      `);

      await pgContext.pool.query(`
        INSERT INTO "post" (title, content, status, metadata, tags, "authorId")
        VALUES ('Hello World', 'Content here', 'PUBLISHED', '{"views": 100}', ARRAY['tech', 'tutorial'], 1)
      `);

      // Verify data
      const users = await pgContext.pool.query(`SELECT * FROM "user"`);
      expect(users.rows[0].email).toBe("test@example.com");
      expect(users.rows[0].role).toBe("ADMIN");
      expect(users.rows[0].tags).toEqual(["developer", "writer"]);
      expect(users.rows[0].preferences).toEqual({ theme: "dark" });

      const posts = await pgContext.pool.query(`SELECT * FROM "post"`);
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
        INSERT INTO "event" (name, "endTime")
        VALUES ('Test Event', '2024-12-31 23:59:59+00')
      `);

      const events = await pgContext.pool.query(`SELECT * FROM "event"`);
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
        INSERT INTO "counter" (value) VALUES (9223372036854775807)
      `);

      const counters = await pgContext.pool.query(`SELECT * FROM "counter"`);
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
        INSERT INTO "price" (amount) VALUES (123.45)
      `);

      const prices = await pgContext.pool.query(`SELECT * FROM "price"`);
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
        INSERT INTO "measurement" (value) VALUES (3.14159)
      `);

      const measurements = await pgContext.pool.query(`SELECT * FROM "measurement"`);
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
      expect(tableNames).toContain("user");
    });
  });
});

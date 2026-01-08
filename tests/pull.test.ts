/**
 * Tests for database pull (introspection) functionality
 *
 * Creates a complex SQLite database with:
 * - Multiple tables with various column types
 * - Foreign key relationships (one-to-many, many-to-one)
 * - Unique indexes (single and composite)
 * - Self-referential foreign keys
 * - Nullable and non-nullable columns
 * - Auto-increment primary keys
 * - Default values
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { pullSchema } from "../src/schema/pull.js";

const TEST_DB_PATH = path.join(process.cwd(), "tests", "pull-test.db");
const OUTPUT_PATH = path.join(process.cwd(), "tests", "pull-output.zmodel");

let sqliteDb: ReturnType<typeof Database> | null = null;

function setupComplexDatabase(): void {
  sqliteDb = new Database(TEST_DB_PATH);

  // Enable foreign keys
  sqliteDb.exec("PRAGMA foreign_keys = ON");

  // 1. Organization table (root entity)
  sqliteDb.exec(`
    CREATE TABLE organization (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 2. User table with foreign key to organization
  sqliteDb.exec(`
    CREATE TABLE user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      organization_id INTEGER NOT NULL,
      manager_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organization(id),
      FOREIGN KEY (manager_id) REFERENCES user(id)
    )
  `);

  // Unique index on email within organization
  sqliteDb.exec(`
    CREATE UNIQUE INDEX idx_user_email_org ON user(email, organization_id)
  `);

  // 3. Role table
  sqliteDb.exec(`
    CREATE TABLE role (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      organization_id INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organization(id)
    )
  `);

  // Unique constraint on role name per organization
  sqliteDb.exec(`
    CREATE UNIQUE INDEX idx_role_name_org ON role(name, organization_id)
  `);

  // 4. User-Role junction table (many-to-many)
  sqliteDb.exec(`
    CREATE TABLE user_role (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      assigned_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (role_id) REFERENCES role(id),
      FOREIGN KEY (assigned_by) REFERENCES user(id)
    )
  `);

  // Unique constraint: user can only have each role once
  sqliteDb.exec(`
    CREATE UNIQUE INDEX idx_user_role_unique ON user_role(user_id, role_id)
  `);

  // 5. Project table
  sqliteDb.exec(`
    CREATE TABLE project (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      organization_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL,
      parent_project_id INTEGER,
      budget REAL,
      start_date TEXT,
      end_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organization(id),
      FOREIGN KEY (owner_id) REFERENCES user(id),
      FOREIGN KEY (parent_project_id) REFERENCES project(id)
    )
  `);

  // Index on project status
  sqliteDb.exec(`
    CREATE INDEX idx_project_status ON project(status)
  `);

  // 6. Task table
  sqliteDb.exec(`
    CREATE TABLE task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      project_id INTEGER NOT NULL,
      assignee_id INTEGER,
      reporter_id INTEGER NOT NULL,
      due_date TEXT,
      estimated_hours REAL,
      actual_hours REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (assignee_id) REFERENCES user(id),
      FOREIGN KEY (reporter_id) REFERENCES user(id)
    )
  `);

  // 7. Comment table (polymorphic-ish, but simplified)
  sqliteDb.exec(`
    CREATE TABLE comment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      parent_comment_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES task(id),
      FOREIGN KEY (author_id) REFERENCES user(id),
      FOREIGN KEY (parent_comment_id) REFERENCES comment(id)
    )
  `);

  // 8. Tag table
  sqliteDb.exec(`
    CREATE TABLE tag (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#808080',
      organization_id INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organization(id)
    )
  `);

  // Unique tag name per organization
  sqliteDb.exec(`
    CREATE UNIQUE INDEX idx_tag_name_org ON tag(name, organization_id)
  `);

  // 9. Task-Tag junction table
  sqliteDb.exec(`
    CREATE TABLE task_tag (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES task(id),
      FOREIGN KEY (tag_id) REFERENCES tag(id)
    )
  `);

  // Unique constraint
  sqliteDb.exec(`
    CREATE UNIQUE INDEX idx_task_tag_unique ON task_tag(task_id, tag_id)
  `);

  // 10. Audit log table (no foreign keys, stores JSON)
  sqliteDb.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      old_values TEXT,
      new_values TEXT,
      user_id INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Index for querying audit logs
  sqliteDb.exec(`
    CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id)
  `);

  sqliteDb.exec(`
    CREATE INDEX idx_audit_user ON audit_log(user_id)
  `);
}

function cleanupDatabase(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }

  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  if (fs.existsSync(OUTPUT_PATH)) {
    fs.unlinkSync(OUTPUT_PATH);
  }
}

describe("pullSchema", () => {
  beforeAll(() => {
    cleanupDatabase();
    setupComplexDatabase();
  });

  afterAll(() => {
    cleanupDatabase();
  });

  it("should introspect all tables from the database", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.tableCount).toBe(10);
    expect(fs.existsSync(OUTPUT_PATH)).toBe(true);
  });

  it("should generate valid datasource and generator blocks", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain('datasource db {');
    expect(result.schema).toContain('provider = "sqlite"');
    expect(result.schema).toContain('url      = env("DATABASE_URL")');
    expect(result.schema).toContain('generator client {');
    expect(result.schema).toContain('provider = "prisma-client-js"');
  });

  it("should generate Organization model with correct fields", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Organization {");
    // SQLite autoincrement columns report as nullable in introspection
    expect(result.schema).toMatch(/id Int\?? @id @default\(autoincrement\(\)\)/);
    expect(result.schema).toContain("name String");
    // slug has unique index - check for @unique attribute
    expect(result.schema).toMatch(/slug String @unique/);
    expect(result.schema).toContain("domain String?");
    // No @@map needed since Organization matches organization (case-insensitive)
  });

  it("should generate User model with foreign key relations", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model User {");
    expect(result.schema).toContain("email String");
    expect(result.schema).toContain("passwordHash String");
    expect(result.schema).toContain("firstName String?");
    expect(result.schema).toContain("organizationId Int");
    expect(result.schema).toContain("managerId Int?");

    // Check relation to organization
    expect(result.schema).toContain("organization Organization @relation(fields: [organizationId], references: [id])");

    // Check self-referential relation (manager)
    expect(result.schema).toContain("user User? @relation(fields: [managerId], references: [id])");
  });

  it("should generate composite unique constraints", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    // User has composite unique on (email, organization_id)
    expect(result.schema).toMatch(/@@unique\(\[email,\s*organizationId\]\)/);

    // Role has composite unique on (name, organization_id)
    expect(result.schema).toMatch(/@@unique\(\[name,\s*organizationId\]\)/);

    // UserRole has composite unique on (user_id, role_id)
    expect(result.schema).toMatch(/@@unique\(\[userId,\s*roleId\]\)/);

    // TaskTag has composite unique on (task_id, tag_id)
    expect(result.schema).toMatch(/@@unique\(\[taskId,\s*tagId\]\)/);
  });

  it("should generate UserRole junction table with multiple foreign keys", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model UserRole {");
    expect(result.schema).toContain("userId Int");
    expect(result.schema).toContain("roleId Int");
    expect(result.schema).toContain("assignedBy Int?");

    // Relations
    expect(result.schema).toContain("@relation(fields: [userId], references: [id])");
    expect(result.schema).toContain("@relation(fields: [roleId], references: [id])");
  });

  it("should generate Project model with self-referential foreign key", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Project {");
    expect(result.schema).toContain("parentProjectId Int?");
    expect(result.schema).toContain("budget Float?");

    // Self-referential relation
    expect(result.schema).toContain("project Project? @relation(fields: [parentProjectId], references: [id])");
  });

  it("should generate Task model with multiple foreign keys to same table", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Task {");
    expect(result.schema).toContain("assigneeId Int?");
    expect(result.schema).toContain("reporterId Int");
    expect(result.schema).toContain("estimatedHours Float?");
    expect(result.schema).toContain("actualHours Float?");
  });

  it("should generate Comment model with self-referential relation", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Comment {");
    expect(result.schema).toContain("parentCommentId Int?");
    expect(result.schema).toContain("comment Comment? @relation(fields: [parentCommentId], references: [id])");
  });

  it("should generate AuditLog model without foreign key relations", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    expect(result.schema).toContain("model AuditLog {");
    expect(result.schema).toContain("entityType String");
    expect(result.schema).toContain("entityId Int");
    expect(result.schema).toContain("action String");
    expect(result.schema).toContain("oldValues String?");
    expect(result.schema).toContain("newValues String?");
    expect(result.schema).toContain("ipAddress String?");
    expect(result.schema).toContain('@@map("audit_log")');
  });

  it("should correctly map snake_case to camelCase field names", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    // Check that snake_case columns are converted to camelCase
    expect(result.schema).toContain("createdAt");
    expect(result.schema).toContain("updatedAt");
    expect(result.schema).toContain("passwordHash");
    expect(result.schema).toContain("firstName");
    expect(result.schema).toContain("lastName");
    expect(result.schema).toContain("isActive");
    expect(result.schema).toContain("organizationId");
    expect(result.schema).toContain("parentProjectId");

    // Check @map attributes for renamed fields
    expect(result.schema).toContain('@map("created_at")');
    expect(result.schema).toContain('@map("updated_at")');
    expect(result.schema).toContain('@map("password_hash")');
    expect(result.schema).toContain('@map("first_name")');
    expect(result.schema).toContain('@map("organization_id")');
  });

  it("should generate reverse relations (one-to-many)", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    // Organization should have reverse relations
    expect(result.schema).toContain("users User[]");
    expect(result.schema).toContain("roles Role[]");
    expect(result.schema).toContain("projects Project[]");
    expect(result.schema).toContain("tags Tag[]");

    // Project should have reverse relation for tasks
    expect(result.schema).toContain("tasks Task[]");

    // Task should have reverse relation for comments and tags
    expect(result.schema).toContain("comments Comment[]");
    expect(result.schema).toContain("taskTags TaskTag[]");
  });

  it("should handle nullable vs non-nullable foreign keys correctly", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    // Non-nullable FK should have non-optional relation
    expect(result.schema).toMatch(/organization Organization @relation/);

    // Nullable FK (manager_id) should have optional relation
    expect(result.schema).toMatch(/user User\? @relation/);
  });

  it("should correctly identify default values", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    // Fields with defaults should have @default attribute
    // Note: SQLite defaults are complex, so we use dbgenerated()
    expect(result.schema).toContain("@default(dbgenerated())");
  });

  it("should write schema to specified output path", async () => {
    const customOutput = path.join(process.cwd(), "tests", "custom-output.zmodel");

    try {
      const result = await pullSchema({
        dialect: "sqlite",
        databasePath: TEST_DB_PATH,
        outputPath: customOutput,
      });

      expect(result.outputPath).toBe(customOutput);
      expect(fs.existsSync(customOutput)).toBe(true);

      const content = fs.readFileSync(customOutput, "utf-8");
      expect(content).toBe(result.schema.trimEnd() + "\n");
    } finally {
      if (fs.existsSync(customOutput)) {
        fs.unlinkSync(customOutput);
      }
    }
  });

  it("should filter out internal SQLite tables", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: TEST_DB_PATH,
      outputPath: OUTPUT_PATH,
    });

    // Should not include sqlite internal tables
    expect(result.schema).not.toContain("sqlite_sequence");
    expect(result.schema).not.toContain("sqlite_master");
  });
});

describe("pullSchema - primary key detection", () => {
  const PK_TEST_DB_PATH = path.join(process.cwd(), "tests", "pk-test.db");
  const PK_OUTPUT_PATH = path.join(process.cwd(), "tests", "pk-output.zmodel");

  let pkDb: ReturnType<typeof Database> | null = null;

  function setupPkTestDatabase(): void {
    pkDb = new Database(PK_TEST_DB_PATH);
    pkDb.exec("PRAGMA foreign_keys = ON");

    // Table with non-id primary key
    pkDb.exec(`
      CREATE TABLE product (
        sku TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL
      )
    `);

    // Table with UUID primary key
    pkDb.exec(`
      CREATE TABLE session (
        uuid TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);

    // Junction table with composite primary key
    pkDb.exec(`
      CREATE TABLE order_item (
        order_id INTEGER NOT NULL,
        product_sku TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL,
        PRIMARY KEY (order_id, product_sku)
      )
    `);

    // Table with composite PK including 3 columns
    pkDb.exec(`
      CREATE TABLE permission (
        role_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        action TEXT NOT NULL,
        allowed INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (role_id, resource, action)
      )
    `);

    // Regular table with id for comparison
    pkDb.exec(`
      CREATE TABLE category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);
  }

  function cleanupPkDatabase(): void {
    if (pkDb) {
      pkDb.close();
      pkDb = null;
    }
    if (fs.existsSync(PK_TEST_DB_PATH)) {
      fs.unlinkSync(PK_TEST_DB_PATH);
    }
    if (fs.existsSync(PK_OUTPUT_PATH)) {
      fs.unlinkSync(PK_OUTPUT_PATH);
    }
  }

  beforeAll(() => {
    cleanupPkDatabase();
    setupPkTestDatabase();
  });

  afterAll(() => {
    cleanupPkDatabase();
  });

  it("should detect non-id single column primary key", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: PK_TEST_DB_PATH,
      outputPath: PK_OUTPUT_PATH,
    });

    // Product should have sku as @id
    // Note: SQLite reports TEXT PRIMARY KEY as nullable, hence String?
    expect(result.schema).toContain("model Product {");
    expect(result.schema).toMatch(/sku String\?? @id/);
    expect(result.schema).toContain("name String");
    expect(result.schema).toContain("price Float");
  });

  it("should detect UUID primary key", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: PK_TEST_DB_PATH,
      outputPath: PK_OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Session {");
    // Note: SQLite reports TEXT PRIMARY KEY as nullable, hence String?
    expect(result.schema).toMatch(/uuid String\?? @id/);
  });

  it("should detect composite primary key with @@id", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: PK_TEST_DB_PATH,
      outputPath: PK_OUTPUT_PATH,
    });

    expect(result.schema).toContain("model OrderItem {");
    // Should NOT have @id on individual fields
    expect(result.schema).not.toMatch(/orderId Int @id/);
    expect(result.schema).not.toMatch(/productSku String @id/);
    // Should have @@id with both fields
    expect(result.schema).toMatch(/@@id\(\[orderId, productSku\]\)/);
  });

  it("should detect 3-column composite primary key", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: PK_TEST_DB_PATH,
      outputPath: PK_OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Permission {");
    expect(result.schema).toMatch(/@@id\(\[roleId, resource, action\]\)/);
  });

  it("should still detect regular id autoincrement primary key", async () => {
    const result = await pullSchema({
      dialect: "sqlite",
      databasePath: PK_TEST_DB_PATH,
      outputPath: PK_OUTPUT_PATH,
    });

    expect(result.schema).toContain("model Category {");
    expect(result.schema).toMatch(/id Int\?? @id @default\(autoincrement\(\)\)/);
    expect(result.schema).toMatch(/name String @unique/);
  });
});

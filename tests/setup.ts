/**
 * Test setup utilities
 *
 * Provides database setup and teardown for tests
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterAll, afterEach, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";

const TEST_DB_PATH = path.join(process.cwd(), "tests", "test.db");

export interface TestDatabase {
  user: {
    id: number;
    email: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
  };
  post: {
    id: number;
    title: string;
    content: string | null;
    published: number;
    authorId: number;
    createdAt: string;
    updatedAt: string;
  };
}

let db: Kysely<TestDatabase> | null = null;
let sqliteDb: any = null;

/**
 * Create a test database instance
 */
export function createTestDb(): Kysely<TestDatabase> {
  if (db) return db;

  sqliteDb = new Database(TEST_DB_PATH);
  db = new Kysely<TestDatabase>({
    dialect: new SqliteDialect({
      database: sqliteDb,
    }),
  });

  return db;
}

/**
 * Initialize the test database schema
 */
export async function setupTestDb(): Promise<void> {
  const testDb = createTestDb();

  // Create tables
  await testDb.executeQuery(
    sql`
      CREATE TABLE IF NOT EXISTS user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `.compile(testDb)
  );

  await testDb.executeQuery(
    sql`
      CREATE TABLE IF NOT EXISTS post (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT,
        published INTEGER NOT NULL DEFAULT 0,
        authorId INTEGER NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (authorId) REFERENCES user(id)
      )
    `.compile(testDb)
  );
}

/**
 * Clean up test data (but keep tables)
 */
export async function cleanupTestDb(): Promise<void> {
  if (!db) return;

  await db.deleteFrom("post").execute();
  await db.deleteFrom("user").execute();
}

/**
 * Remove the test database file
 */
export function removeTestDb(): void {
  if (db) {
    db.destroy();
    db = null;
  }

  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }

  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

// Global setup and teardown
beforeAll(async () => {
  removeTestDb();
  await setupTestDb();
});

afterEach(async () => {
  await cleanupTestDb();
});

afterAll(() => {
  removeTestDb();
});

/**
 * PostgreSQL pullSchema integration test with tricky schema
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  startPostgresContainer,
  stopPostgresContainer,
  cleanDatabase,
  type PostgresTestContext,
} from "./postgres-testcontainer.js";
import { pullSchema } from "../src/schema/pull.js";

const TEST_DIR = path.join(process.cwd(), "tests", "postgres-pull");
const OUTPUT_PATH = path.join(TEST_DIR, "schema.zmodel");

let pgContext: PostgresTestContext;

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

describe("pullSchema - PostgreSQL tricky schema", () => {
  beforeAll(async () => {
    cleanup();
    pgContext = await startPostgresContainer();
  }, 60000);

  afterAll(async () => {
    cleanup();
    await stopPostgresContainer();
  }, 30000);

  beforeEach(async () => {
    await cleanDatabase(pgContext.pool);
  });

  it("should pull types and defaults from a tricky schema", async () => {
    await pgContext.pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pgContext.pool.query(`CREATE TYPE status_enum AS ENUM ('active', 'inactive')`);

    await pgContext.pool.query(`
      CREATE TABLE account (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        is_active boolean NOT NULL DEFAULT true,
        score integer NOT NULL DEFAULT 0,
        name text NOT NULL,
        metadata jsonb,
        status status_enum NOT NULL,
        tags text[] NOT NULL DEFAULT ARRAY[]::text[]
      );
    `);

    await pgContext.pool.query(`
      CREATE TABLE asset (
        id serial PRIMARY KEY,
        payload bytea
      );
    `);

    const result = await pullSchema({
      dialect: "postgres",
      connectionUrl: pgContext.connectionUrl,
      outputPath: OUTPUT_PATH,
      writeFile: false,
    });

    expect(result.schema).toContain('provider = "postgresql"');
    expect(result.schema).toContain("model Account {");
    expect(result.schema).toContain("model Asset {");
    expect(result.schema).toContain("id String @id @default(uuid())");
    expect(result.schema).toContain("createdAt DateTime @map(\"created_at\") @default(now())");
    expect(result.schema).toContain("isActive Boolean @map(\"is_active\") @default(true)");
    expect(result.schema).toContain("score Int @default(0)");
    expect(result.schema).toContain("metadata Json?");
    expect(result.schema).toContain("payload Bytes?");
  });
});

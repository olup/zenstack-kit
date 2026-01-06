/**
 * CLI integration tests
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import Database from "better-sqlite3";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
  const tsxLoaderPath = require.resolve("tsx");
  const tsxLoader = tsxLoaderPath.replace(/\\/g, "/");
const cliPath = path.join(process.cwd(), "src", "cli.ts");

function runCli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      ["--import", tsxLoader, cliPath, ...args],
      { cwd, env: { ...process.env, ...extraEnv } },
      (error, stdout, stderr) => {
        if (error) {
          const err = new Error(stderr || String(error));
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

describe("zenstack-kit CLI", () => {
  it("should generate and apply migrations via CLI", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");
    const dbPath = path.join(tempDir, "cli-test.db");

    const schema = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id   Int    @id @default(autoincrement())\n  name String\n}\n`;

    try {
      await fs.writeFile(schemaPath, schema, "utf-8");

      await runCli(
        [
          "migrate:generate",
          "--name",
          "initial",
          "--schema",
          schemaPath,
          "--migrations",
          migrationsPath,
        ],
        tempDir,
      );

      await runCli(
        [
          "migrate:apply",
          "--dialect",
          "sqlite",
          "--url",
          dbPath,
          "--migrations",
          migrationsPath,
        ],
        tempDir,
      );

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

  it("should require connection URL for non-sqlite dialects", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));

    try {
      await expect(
        runCli(["migrate:apply", "--dialect", "postgres"], tempDir),
      ).rejects.toThrow("Database connection URL is required for non-sqlite dialects");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should resolve renames and confirm destructive changes via prompts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenstack-kit-cli-"));
    const schemaPath = path.join(tempDir, "schema.zmodel");
    const migrationsPath = path.join(tempDir, "migrations");

    const schemaV1 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel User {\n  id    Int     @id @default(autoincrement())\n  name  String\n  email String\n}\n`;

    const schemaV2 = `datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./test.db\"\n}\n\ngenerator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel Person {\n  id    Int     @id @default(autoincrement())\n  name  String\n  mail  String\n}\n`;

    try {
      await fs.writeFile(schemaPath, schemaV1, "utf-8");

      await runCli(
        [
          "migrate:generate",
          "--name",
          "initial",
          "--schema",
          schemaPath,
          "--migrations",
          migrationsPath,
        ],
        tempDir,
      );

      await fs.writeFile(schemaPath, schemaV2, "utf-8");

      const answers = ["person", "mail", "y"];
      await runCli(
        [
          "migrate:generate",
          "--name",
          "rename_user",
          "--schema",
          schemaPath,
          "--migrations",
          migrationsPath,
        ],
        tempDir,
        { ZENSTACK_KIT_PROMPT_ANSWERS: JSON.stringify(answers) },
      );

      const files = await fs.readdir(migrationsPath);
      const migrationFile = files.find((file) => file.includes("rename_user"));
      if (!migrationFile) {
        throw new Error("Expected rename migration to be written");
      }

      const migrationContent = await fs.readFile(path.join(migrationsPath, migrationFile), "utf-8");
      expect(migrationContent).toContain("renameTo('person')");
      expect(migrationContent).toContain("renameColumn('email', 'mail')");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

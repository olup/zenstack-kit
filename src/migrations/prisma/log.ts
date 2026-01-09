import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

export interface MigrationLogEntry {
  /** Migration folder name e.g. "20260108120000_init" */
  name: string;
  /** SHA256 checksum of migration.sql content (64 hex chars) */
  checksum: string;
}

const MIGRATION_LOG_HEADER = `# zenstack-kit migration log
# Format: <migration_name> <checksum>
`;

/**
 * Calculate SHA256 checksum of migration SQL
 */
export function calculateChecksum(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

/**
 * Get the path to the migration log file
 */
export function getMigrationLogPath(outputPath: string): string {
  return path.join(outputPath, "meta", "_migration_log");
}

/**
 * Parse migration log content into entries
 */
function parseMigrationLog(content: string): MigrationLogEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [name, checksum] = line.split(" ");
      return { name, checksum };
    })
    .filter((entry) => entry.name && entry.checksum);
}

/**
 * Serialize migration log entries to string
 */
function serializeMigrationLog(entries: MigrationLogEntry[]): string {
  const lines = entries.map((e) => `${e.name} ${e.checksum}`).join("\n");
  return MIGRATION_LOG_HEADER + lines + (lines.length > 0 ? "\n" : "");
}

/**
 * Read migration log file
 */
export async function readMigrationLog(outputPath: string): Promise<MigrationLogEntry[]> {
  const logPath = getMigrationLogPath(outputPath);
  try {
    const content = await fs.readFile(logPath, "utf-8");
    return parseMigrationLog(content);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Write migration log file
 */
export async function writeMigrationLog(outputPath: string, entries: MigrationLogEntry[]): Promise<void> {
  const logPath = getMigrationLogPath(outputPath);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, serializeMigrationLog(entries), "utf-8");
}

/**
 * Append a single entry to the migration log
 */
export async function appendToMigrationLog(outputPath: string, entry: MigrationLogEntry): Promise<void> {
  const entries = await readMigrationLog(outputPath);
  entries.push(entry);
  await writeMigrationLog(outputPath, entries);
}

/**
 * Scan migration folders and compute checksums for each
 */
export async function scanMigrationFolders(outputPath: string): Promise<MigrationLogEntry[]> {
  const entries: MigrationLogEntry[] = [];

  try {
    const dirEntries = await fs.readdir(outputPath, { withFileTypes: true });
    const migrationFolders = dirEntries
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();

    for (const folderName of migrationFolders) {
      const sqlPath = path.join(outputPath, folderName, "migration.sql");
      try {
        const sqlContent = await fs.readFile(sqlPath, "utf-8");
        const checksum = calculateChecksum(sqlContent);
        entries.push({ name: folderName, checksum });
      } catch {
        // Skip folders without migration.sql
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries;
}

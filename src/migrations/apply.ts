/**
 * Apply migrations using Kysely's migrator
 */

import * as path from "path";
import type { MigrationProvider } from "kysely";
import type { KyselyDialect } from "../sql/kysely-adapter.js";
import { createKyselyAdapter } from "../sql/kysely-adapter.js";

export interface ApplyMigrationsOptions {
  migrationsFolder: string;
  dialect: KyselyDialect;
  connectionUrl?: string;
  databasePath?: string;
}

export interface ApplyMigrationsResult {
  results: Array<{ migrationName: string; status: string }>
}

export async function applyMigrations(options: ApplyMigrationsOptions): Promise<ApplyMigrationsResult> {
  const databasePath =
    options.databasePath ??
    (options.dialect === "sqlite" ? resolveSqlitePath(options.connectionUrl) : undefined);

  const { db, destroy } = await createKyselyAdapter({
    dialect: options.dialect,
    connectionUrl: options.connectionUrl,
    databasePath,
  });

  try {
    const { Migrator } = await import("kysely");
    const fs = await import("fs/promises");
    const { default: jiti } = await import("jiti");
    const loader = jiti(import.meta.url, { interopDefault: true });

    const provider: MigrationProvider = {
      async getMigrations() {
        const entries = await fs.readdir(options.migrationsFolder);
        const files = entries
          .filter((file) => /\.(ts|js|mjs|cjs)$/.test(file))
          .sort((a, b) => a.localeCompare(b));

        const migrations: Record<string, { up: (db: any) => Promise<void>; down: (db: any) => Promise<void> }> = {};

        for (const file of files) {
          const filePath = path.join(options.migrationsFolder, file);
          const mod = loader(filePath);
          const migration = mod.default ?? mod;

          if (!migration?.up || !migration?.down) {
            throw new Error(`Migration file is missing up/down exports: ${file}`);
          }

          migrations[path.parse(file).name] = migration;
        }

        return migrations;
      },
    };

    const migrator = new Migrator({ db, provider });

    const { error, results } = await migrator.migrateToLatest();

    if (error) {
      throw error;
    }

    return {
      results:
        results?.map((result) => ({
          migrationName: result.migrationName,
          status: result.status,
        })) ?? [],
    };
  } finally {
    await destroy();
  }
}

function resolveSqlitePath(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("file:")) {
    return url.slice("file:".length);
  }
  return url;
}

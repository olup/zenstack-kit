/**
 * PostgreSQL testcontainer helpers for integration tests
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

type PoolType = InstanceType<typeof pg.Pool>;

export interface PostgresTestContext {
  container: StartedPostgreSqlContainer;
  connectionUrl: string;
  pool: PoolType;
}

let sharedContainer: StartedPostgreSqlContainer | null = null;
let sharedPool: PoolType | null = null;
let containerRefCount = 0;

/**
 * Start a PostgreSQL container for testing.
 * Uses a shared container across tests for performance.
 */
export async function startPostgresContainer(): Promise<PostgresTestContext> {
  if (!sharedContainer) {
    sharedContainer = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("test_db")
      .withUsername("test_user")
      .withPassword("test_password")
      .start();

    sharedPool = new pg.Pool({
      connectionString: sharedContainer.getConnectionUri(),
    });
  }

  containerRefCount++;

  return {
    container: sharedContainer,
    connectionUrl: sharedContainer.getConnectionUri(),
    pool: sharedPool!,
  };
}

/**
 * Stop the PostgreSQL container.
 * Only actually stops when all references are released.
 */
export async function stopPostgresContainer(): Promise<void> {
  containerRefCount--;

  if (containerRefCount <= 0 && sharedContainer) {
    if (sharedPool) {
      await sharedPool.end();
      sharedPool = null;
    }
    await sharedContainer.stop();
    sharedContainer = null;
    containerRefCount = 0;
  }
}

/**
 * Clean the database by dropping all tables except system tables.
 * Useful between tests to get a clean slate.
 */
export async function cleanDatabase(pool: PoolType): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      -- Drop all tables in public schema
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
      LOOP
        EXECUTE 'DROP TABLE IF EXISTS public."' || r.tablename || '" CASCADE';
      END LOOP;

      -- Drop all types (enums) in public schema
      FOR r IN (SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e')
      LOOP
        EXECUTE 'DROP TYPE IF EXISTS public."' || r.typname || '" CASCADE';
      END LOOP;
    END $$;
  `);
}

/**
 * Create a fresh database for a test by creating a new schema.
 */
export async function createTestSchema(pool: PoolType, schemaName: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
}

/**
 * Drop a test schema.
 */
export async function dropTestSchema(pool: PoolType, schemaName: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

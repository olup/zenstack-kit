# zenstack-kit

Drizzle-kit like CLI tooling for ZenStack schemas with Prisma-compatible migrations.

## Features

- **Prisma-Compatible Migrations** - Generates SQL migrations in Prisma folder format (`migrations/<timestamp>_<name>/migration.sql`)
- **Migration Tracking** - Uses `_prisma_migrations` table, compatible with `prisma migrate deploy`
- **Database Introspection** - Generate ZenStack schemas from existing databases
- **Interactive CLI** - Beautiful terminal UI powered by Ink with command selection and prompts
- **No Prisma Dependency** - Uses ZenStack AST directly for diffing and Kysely for SQL compilation
- **Multi-Dialect Support** - SQLite, PostgreSQL, and MySQL
- **Type-Safe Configuration** - Configuration via `defineConfig()` with full TypeScript support

## Installation

```bash
pnpm add zenstack-kit kysely
```

## Quick Start

### 1. Create a configuration file

```ts
// zenstack-kit.config.ts
import { defineConfig } from "zenstack-kit";

export default defineConfig({
  schema: "./schema.zmodel",
  dialect: "postgres",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
```

For SQLite, use `file` instead of `url`:

```ts
export default defineConfig({
  schema: "./schema.zmodel",
  dialect: "sqlite",
  dbCredentials: {
    file: "./dev.db",
  },
});
```

### 2. Create a ZenStack schema

```zmodel
datasource db {
  provider = "postgres"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  name  String
  email String @unique
}
```

### 3. Initialize the migration system

```bash
# Interactive mode - launches the CLI menu
zenstack-kit

# Or run init directly
zenstack-kit init
```

The `init` command offers two options:
- **Baseline only** - Create a snapshot without generating a migration (use when your database already matches the schema)
- **Create initial migration** - Create a snapshot and generate an initial migration (use when starting fresh)

### 4. Generate migrations

```bash
zenstack-kit migrate create --name add_posts
```

This creates a migration in Prisma format:
```
prisma/migrations/
  20240115120000_add_posts/
    migration.sql
  meta/
    _snapshot.json
    _migration_log
```

### 5. Apply migrations

```bash
zenstack-kit migrate apply
```

Migrations are tracked in the `_prisma_migrations` table, making them compatible with `prisma migrate deploy`.

### Migration log and checksums

zenstack-kit maintains `meta/_migration_log` alongside your migrations. It stores a SHA256 checksum for each `migration.sql` so integrity checks work even when you never apply migrations locally.

Flow:
- On `migrate create`, a checksum entry is appended to the log.
- On `migrate apply`, applied migrations are verified against the database and log.
- For pending migrations, the log is auto-updated from disk by default (so edits or empty migrations do not require manual rehash).
- Use `--strict` (or `ZENSTACK_MIGRATION_STRICT=1`) to disable auto-rehash and fail on any pending mismatch (recommended for CI).

## CLI Commands

Run `zenstack-kit` without arguments to launch the interactive menu, or run commands directly. For CI or non-TTY environments, pass `--no-ui` to bypass Ink.

Global options:
- `--no-ui` - Disable Ink UI (useful for CI/non-TTY)

### `zenstack-kit init`

Initialize the migration system for your project.

```bash
# Interactive mode
zenstack-kit init

# Non-interactive: baseline only (database already matches schema)
zenstack-kit init --baseline

# Non-interactive: create initial migration (fresh database)
zenstack-kit init --create-initial
```

Options:
- `-s, --schema <path>` - Path to ZenStack schema
- `-m, --migrations <path>` - Migrations directory
- `--baseline` - Create snapshot only, no migration
- `--create-initial` - Create snapshot and initial migration
- `-c, --config <path>` - Path to zenstack-kit config file

### `zenstack-kit migrate create`

Generate a new SQL migration from schema changes.

```bash
zenstack-kit migrate create --name add_users
```

Options:
- `-n, --name <name>` - Migration name (prompted if omitted in interactive mode)
- `-s, --schema <path>` - Path to ZenStack schema
- `-m, --migrations <path>` - Migrations directory
- `--dialect <dialect>` - Database dialect (`sqlite`, `postgres`, `mysql`)
- `--empty` - Create an empty migration (no schema diff)
- `--update-snapshot` - Update snapshot when used with `--empty`
- `-c, --config <path>` - Path to zenstack-kit config file

### `zenstack-kit migrate apply`

Apply pending migrations to the database.

```bash
zenstack-kit migrate apply
```

Options:
- `-m, --migrations <path>` - Migrations directory
- `--dialect <dialect>` - Database dialect
- `--url <url>` - Database connection URL (overrides config)
- `--table <name>` - Migrations table name (default: `_prisma_migrations`)
- `--db-schema <name>` - Database schema for migrations table (PostgreSQL only, default: `public`)
- `--migration <name>` - Apply a single migration (must be the next pending one)
- `--preview` - Preview pending migrations without applying
- `--mark-applied` - Mark pending migrations as applied without running SQL
- `--strict` - Enforce pending migration log checksums (no auto-rehash)
- `-c, --config <path>` - Path to zenstack-kit config file

### `zenstack-kit migrate rehash`

Rebuild the migration log checksums from the `migration.sql` files (useful after manual edits or when strict mode fails).

```bash
zenstack-kit migrate rehash
```

Options:
- `-m, --migrations <path>` - Migrations directory
- `--migration <name>` - Rehash a single migration folder
- `-c, --config <path>` - Path to zenstack-kit config file

### `zenstack-kit pull`

Introspect an existing database and generate a ZenStack schema.

```bash
zenstack-kit pull --output schema.zmodel
```

Options:
- `-o, --output <path>` - Output path for schema (default: `./schema.zmodel`)
- `--dialect <dialect>` - Database dialect
- `--url <url>` - Database connection URL
- `--preview` - Preview generated schema and diff without writing files
- `-c, --config <path>` - Path to zenstack-kit config file

Features:
- Detects tables, columns, and types
- Extracts primary keys (single and composite)
- Extracts unique constraints and indexes
- Extracts foreign key relationships
- Converts snake_case to camelCase with `@map` attributes

## Configuration

Create a `zenstack-kit.config.ts` file in your project root:

```ts
import { defineConfig } from "zenstack-kit";

export default defineConfig({
  // Path to your ZenStack schema
  schema: "./schema.zmodel",

  // Database dialect: "sqlite" | "postgres" | "mysql"
  dialect: "postgres",

  // Database credentials (dialect-specific)
  dbCredentials: {
    url: process.env.DATABASE_URL,  // For postgres/mysql
    // file: "./dev.db",            // For sqlite
  },

  // Migration settings
  migrations: {
    migrationsFolder: "./prisma/migrations",  // Default
    migrationsTable: "_prisma_migrations",    // Default
    migrationsSchema: "public",               // PostgreSQL only
  },
});
```

CLI flags override config file values.

## Programmatic API

### `createPrismaMigration(options)`

Create a Prisma-compatible SQL migration.

```ts
import { createPrismaMigration } from "zenstack-kit";

const migration = await createPrismaMigration({
  name: "add_users",
  schemaPath: "./schema.zmodel",
  outputPath: "./prisma/migrations",
  dialect: "postgres",
});

if (migration) {
  console.log(migration.folderName); // "20240115120000_add_users"
  console.log(migration.sql);
}
```

### `applyPrismaMigrations(options)`

Apply pending migrations to the database.

```ts
import { applyPrismaMigrations } from "zenstack-kit";

const result = await applyPrismaMigrations({
  migrationsFolder: "./prisma/migrations",
  dialect: "postgres",
  connectionUrl: process.env.DATABASE_URL,
});

console.log(result.applied);        // [{ migrationName: "...", duration: 42 }]
console.log(result.alreadyApplied); // ["20240114000000_init"]
```

### `hasPrismaSchemaChanges(options)`

Check if there are pending schema changes.

```ts
import { hasPrismaSchemaChanges } from "zenstack-kit";

const hasChanges = await hasPrismaSchemaChanges({
  schemaPath: "./schema.zmodel",
  outputPath: "./prisma/migrations",
});
```

### `pullSchema(options)`

Introspect a database and generate a ZenStack schema.

```ts
import { pullSchema } from "zenstack-kit";

const result = await pullSchema({
  dialect: "postgres",
  connectionUrl: process.env.DATABASE_URL,
  outputPath: "./schema.zmodel",
});

console.log(result.tableCount); // 5
```

### `createKyselyAdapter(options)`

Create a Kysely instance for your database.

```ts
import { createKyselyAdapter } from "zenstack-kit";

const { db, destroy } = await createKyselyAdapter({
  dialect: "postgres",
  connectionUrl: process.env.DATABASE_URL,
});

// Use db for queries...
await destroy();
```

## Experimental

The `introspectSchema` API is experimental and uses a simplified parser. Expect
limitations with complex schemas.

## Prisma Compatibility

zenstack-kit is designed to be compatible with Prisma's migration system:

- **Same folder structure** - `migrations/<timestamp>_<name>/migration.sql`
- **Same tracking table** - `_prisma_migrations` with identical schema
- **Interoperable** - Teams can use `prisma migrate deploy` to apply zenstack-kit migrations

Constraint naming follows Prisma conventions:
- Primary keys: `<table>_pkey`
- Unique constraints: `<table>_<columns>_key`
- Indexes: `<table>_<columns>_idx`
- Foreign keys: `<table>_<columns>_fkey`

## Requirements

- Node.js 18+
- `kysely` >= 0.27.0

## License

MIT

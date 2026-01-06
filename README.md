# zenstack-kit

Drizzle-kit like CLI tooling for ZenStack schemas with Kysely support.

## Features

- **Migration Generation** - Create Kysely migrations from ZenStack schema changes
- **Database Introspection** - Generate ZenStack schemas from existing databases
- **No Prisma Dependency** - Uses ZenStack AST directly for diffing
- **Multi-Dialect Support** - SQLite, PostgreSQL, and MySQL
- **Configuration File** - Type-safe configuration via `defineConfig()`

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

### 3. Generate ZenStack artifacts

```bash
zenstack generate
```

### 4. Generate a migration

```bash
zenstack-kit migrate:generate --name init
```

### 5. Apply migrations with Kysely

```bash
zenstack-kit migrate:apply --dialect postgres --url "$DATABASE_URL"
```

## CLI Commands

Configuration:
- The CLI loads `zenstack-kit.config.ts|js|mjs|cjs` automatically when present.
- CLI flags override config values.

### `zenstack-kit migrate:generate`

Generate a new migration file based on schema changes.

```bash
zenstack-kit migrate:generate --name add_users
```

Options:
- `-n, --name <name>` - Migration name (if omitted, you'll be prompted)
- `-s, --schema <path>` - Path to ZenStack schema (defaults to config or `./schema.zmodel`)
- `-m, --migrations <path>` - Migrations directory (defaults to config or `./migrations`)

Snapshots:
- A schema snapshot is stored at `./migrations/meta/_snapshot.json` and used to diff changes.
- Naming is deterministic and explicit to avoid engine-specific defaults:
  - `pk_<table>`, `uniq_<table>_<cols>`, `idx_<table>_<cols>`, `fk_<table>_<col>_<refTable>_<refCol>`
- If tables or columns are removed and new ones are added, the CLI will prompt to resolve renames.
- Destructive changes (table/column drops) require confirmation before a migration is written.

### `zenstack-kit migrate:apply`

Apply pending migrations using Kysely's migrator.

```bash
zenstack-kit migrate:apply --dialect postgres --url postgres://...
```

Options:
- `-m, --migrations <path>` - Migrations directory (defaults to config or `./migrations`)
- `--dialect <dialect>` - Database dialect (defaults to config or `sqlite`)
- `--url <url>` - Database connection URL (defaults to config). For sqlite, pass a file path or `file:...` URL.
  - For non-sqlite dialects, a URL is required.

### `zenstack-kit pull`

Introspect an existing database and generate a ZenStack schema file.

```bash
zenstack-kit pull --dialect postgres --url postgres://... --output schema.zmodel
```

Options:
- `-o, --output <path>` - Output path for schema (defaults to `./schema.zmodel`)
- `--dialect <dialect>` - Database dialect (defaults to config or `sqlite`)
- `--url <url>` - Database connection URL (defaults to config). For sqlite, pass a file path or `file:...` URL.

Features:
- Detects tables, columns, and types
- Extracts primary keys (single and composite via `@@id`)
- Extracts unique constraints (single `@unique` and composite `@@unique`)
- Extracts foreign key relationships and generates `@relation` fields
- Extracts indexes and generates `@@index`
- Converts snake_case column names to camelCase with `@map` attributes
- Generates `@@map` when table names differ from model names

## API Reference

### `introspectSchema(options)`

Introspect a ZenStack schema file.

```ts
import { introspectSchema } from "zenstack-kit";

const schema = await introspectSchema({
  schemaPath: "./schema.zmodel",
});

console.log(schema.models); // [{ name: "User", fields: [...] }, ...]
```

### `createMigration(options)`

Create a migration file.

```ts
import { createMigration } from "zenstack-kit";

const migration = await createMigration({
  name: "add_users",
  schemaPath: "./schema.zmodel",
  outputPath: "./migrations",
});

if (migration) {
  console.log(migration.filename); // "20240115120000_add_users.ts"
}
```

### `createKyselyAdapter(options)`

Create a Kysely instance configured for your database.

```ts
import { createKyselyAdapter } from "zenstack-kit";

const { db, destroy } = await createKyselyAdapter({
  dialect: "postgres",
  connectionUrl: process.env.DATABASE_URL,
});

// Use db...
await destroy();
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

console.log(result.outputPath); // "./schema.zmodel"
console.log(result.tableCount); // 5
```

### `defineConfig(config)`

Define configuration with type safety.

```ts
import { defineConfig } from "zenstack-kit";

export default defineConfig({
  schema: "./schema.zmodel",
  dialect: "postgres",
  migrations: {
    migrationsFolder: "./migrations",
  },
});
```

## Requirements

- Node.js 18+
- `kysely` >= 0.27.0

## Future Improvements

- Dialect-specific column type mappings and defaults
- Safer diffing for destructive changes (rename detection, column type narrowing warnings)
- Migration status/rollback CLI helpers on top of Kysely migrator

## License

MIT

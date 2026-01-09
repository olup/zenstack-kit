export {
  createPrismaMigration,
  createInitialMigration,
  hasPrismaSchemaChanges,
  type PrismaMigrationOptions,
  type PrismaMigration,
  type CreateInitialMigrationOptions,
} from "./prisma/create.js";

export {
  applyPrismaMigrations,
  previewPrismaMigrations,
  type ApplyPrismaMigrationsOptions,
  type ApplyPrismaMigrationsResult,
  type PreviewPrismaMigrationsResult,
  type MigrationCoherenceError,
  type MigrationCoherenceResult,
} from "./prisma/apply.js";

export {
  readMigrationLog,
  writeMigrationLog,
  appendToMigrationLog,
  scanMigrationFolders,
  getMigrationLogPath,
  calculateChecksum,
  type MigrationLogEntry,
} from "./prisma/log.js";

export {
  initializeSnapshot,
  hasSnapshot,
  getSnapshotPaths,
  writeSnapshot,
} from "./prisma/snapshot.js";

export {
  detectPotentialRenames,
  type PotentialTableRename,
  type PotentialColumnRename,
  type PotentialRenames,
} from "./prisma/rename.js";

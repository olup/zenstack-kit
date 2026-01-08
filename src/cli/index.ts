#!/usr/bin/env node

/**
 * zenstack-kit CLI - Database tooling for ZenStack schemas
 *
 * Commands:
 *   migrate:generate  Generate a new SQL migration
 *   migrate:apply     Apply pending migrations
 *   init              Initialize snapshot from existing schema
 *   pull              Introspect database and generate schema
 */

import { runCli } from "./app.js";

runCli();

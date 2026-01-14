#!/usr/bin/env node

/**
 * zenstack-kit CLI - Database tooling for ZenStack schemas
 *
 * Commands:
 *   migrate create    Generate a new SQL migration
 *   migrate apply     Apply pending migrations
 *   migrate rehash    Rebuild migration log checksums from migration.sql files
 *   init              Initialize snapshot from existing schema
 *   pull              Introspect database and generate schema
 */

import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import {
  runMigrateGenerate,
  runMigrateApply,
  runMigrateRehash,
  runInit,
  runPull,
  CommandError,
  type CommandContext,
  type CommandOptions,
  type LogFn,
} from "./commands.js";
import {
  promptSnapshotExists,
  promptFreshInit,
  promptPullConfirm,
  promptTableRename,
  promptColumnRename,
  promptMigrationName,
  promptMigrationConfirm,
} from "./prompts.js";

type Command = "migrate create" | "migrate apply" | "migrate rehash" | "init" | "pull" | "help" | "exit";

interface CommandOption {
  label: string;
  value: Command;
  description: string;
}

const commands: CommandOption[] = [
  { label: "migrate create", value: "migrate create", description: "Generate a new SQL migration file" },
  { label: "migrate apply", value: "migrate apply", description: "Apply pending SQL migrations" },
  { label: "migrate rehash", value: "migrate rehash", description: "Rebuild migration log checksums" },
  { label: "init", value: "init", description: "Initialize snapshot from existing schema" },
  { label: "pull", value: "pull", description: "Introspect database and generate schema" },
  { label: "help", value: "help", description: "Show help information" },
  { label: "exit", value: "exit", description: "Exit the CLI" },
];

// Parse command line arguments
function parseArgs(): { command?: Command; options: CommandOptions } {
  const args = process.argv.slice(2);
  const options: CommandOptions = {};
  let command: Command | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Handle "migrate create", "migrate apply", and "migrate rehash" subcommands
    if (arg === "migrate" && args[i + 1] === "create") {
      command = "migrate create";
      i++; // Skip the next argument
    } else if (arg === "migrate" && args[i + 1] === "apply") {
      command = "migrate apply";
      i++; // Skip the next argument
    } else if (arg === "migrate" && args[i + 1] === "rehash") {
      command = "migrate rehash";
      i++; // Skip the next argument
    } else if (arg === "init" || arg === "pull" || arg === "help") {
      command = arg as Command;
    } else if (arg === "--name" || arg === "-n") {
      options.name = args[++i];
    } else if (arg === "--schema" || arg === "-s") {
      options.schema = args[++i];
    } else if (arg === "--migrations" || arg === "-m") {
      options.migrations = args[++i];
    } else if (arg === "--migration") {
      options.migration = args[++i];
    } else if (arg === "--no-ui") {
      options.noUi = true;
    } else if (arg === "--dialect") {
      options.dialect = args[++i];
    } else if (arg === "--url") {
      options.url = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[++i];
    } else if (arg === "--table") {
      options.table = args[++i];
    } else if (arg === "--db-schema") {
      options.dbSchema = args[++i];
    } else if (arg === "--baseline") {
      options.baseline = true;
    } else if (arg === "--create-initial") {
      options.createInitial = true;
    } else if (arg === "--preview") {
      options.preview = true;
    } else if (arg === "--mark-applied") {
      options.markApplied = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--config" || arg === "-c") {
      options.config = args[++i];
    }
  }

  return { command, options };
}

// Status component for showing messages
function Status({ type, message }: { type: "info" | "success" | "error" | "warning"; message: string }) {
  const colors = {
    info: "blue",
    success: "green",
    error: "red",
    warning: "yellow",
  } as const;

  const symbols = {
    info: "ℹ",
    success: "✓",
    error: "✗",
    warning: "⚠",
  };

  return (
    <Text color={colors[type]}>
      {symbols[type]} {message}
    </Text>
  );
}

// Help display component
function HelpDisplay() {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">zenstack-kit</Text>
      <Text dimColor>Database tooling for ZenStack schemas</Text>
      <Text> </Text>
      <Text bold>Commands:</Text>
      {commands.filter(c => c.value !== "exit").map((cmd) => (
        <Box key={cmd.value} marginLeft={2}>
          <Box width={20}>
            <Text color="yellow">{cmd.label}</Text>
          </Box>
          <Text dimColor>{cmd.description}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text bold>Options:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text dimColor>-s, --schema &lt;path&gt;     Path to ZenStack schema</Text>
        <Text dimColor>-m, --migrations &lt;path&gt;  Migrations directory</Text>
        <Text dimColor>-n, --name &lt;name&gt;        Migration name</Text>
        <Text dimColor>--dialect &lt;dialect&gt;      Database dialect (sqlite, postgres, mysql)</Text>
        <Text dimColor>--url &lt;url&gt;              Database connection URL</Text>
        <Text dimColor>--migration &lt;name&gt;       Target a single migration (rehash only)</Text>
        <Text dimColor>--no-ui                   Disable Ink UI (useful for CI/non-TTY)</Text>
        <Text dimColor>--create-initial         Create initial migration (skip prompt)</Text>
        <Text dimColor>--baseline               Create baseline only (skip prompt)</Text>
        <Text dimColor>--preview                Preview pending migrations without applying</Text>
        <Text dimColor>--mark-applied           Mark pending migrations as applied without running SQL</Text>
        <Text dimColor>-f, --force              Force operation without confirmation</Text>
        <Text dimColor>-c, --config &lt;path&gt;     Path to zenstack-kit config file</Text>
      </Box>
    </Box>
  );
}

// Main CLI App component
interface CliAppProps {
  initialCommand?: Command;
  options: CommandOptions;
}

function CliApp({ initialCommand, options }: CliAppProps) {
  const { exit } = useApp();
  const [command, setCommand] = useState<Command | null>(initialCommand || null);
  const [phase, setPhase] = useState<"select" | "input" | "running" | "done">(initialCommand ? "running" : "select");
  const [migrationName, setMigrationName] = useState<string | null>(options.name || null);
  const [logs, setLogs] = useState<Array<{ type: "info" | "success" | "error" | "warning"; message: string }>>([]);

  const log: LogFn = (type, message) => {
    setLogs((prev) => [...prev, { type, message }]);
  };

  // Handle command selection
  const handleSelect = (item: { value: Command }) => {
    if (item.value === "exit") {
      exit();
      return;
    }
    if (item.value === "help") {
      setCommand("help");
      setPhase("done");
      return;
    }
    setCommand(item.value);
    // Always go to running - migration name prompt now happens after disambiguation
    setPhase("running");
  };

  // Execute commands
  useEffect(() => {
    if (phase !== "running" || !command) return;

    const run = async () => {
      const ctx: CommandContext = {
        cwd: process.cwd(),
        options: { ...options, name: migrationName || options.name },
        log,
        promptSnapshotExists: async () => {
          const choice = await promptSnapshotExists();
          return choice as "skip" | "reinitialize";
        },
        promptFreshInit: async () => {
          const choice = await promptFreshInit();
          return choice as "baseline" | "create_initial";
        },
        promptPullConfirm: async (existingFiles: string[]) => {
          return await promptPullConfirm(existingFiles);
        },
        promptTableRename: async (from: string, to: string) => {
          return await promptTableRename(from, to);
        },
        promptColumnRename: async (table: string, from: string, to: string) => {
          return await promptColumnRename(table, from, to);
        },
        promptMigrationName: async (defaultName: string) => {
          return await promptMigrationName(defaultName);
        },
        promptMigrationConfirm: async (migrationPath: string) => {
          return await promptMigrationConfirm(migrationPath);
        },
      };

      try {
        if (command === "migrate create") {
          await runMigrateGenerate(ctx);
        } else if (command === "migrate apply") {
          await runMigrateApply(ctx);
        } else if (command === "migrate rehash") {
          await runMigrateRehash(ctx);
        } else if (command === "init") {
          await runInit(ctx);
        } else if (command === "pull") {
          await runPull(ctx);
        }
      } catch (err) {
        if (err instanceof CommandError) {
          log("error", err.message);
        } else {
          log("error", `Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setPhase("done");
    };

    run();
  }, [phase, command]);

  // Exit after command completes (for non-interactive mode, or on error)
  useEffect(() => {
    if (phase === "done" && command !== "help") {
      const hasError = logs.some((l) => l.type === "error");

      // Always exit on error, or exit in non-interactive mode
      if (hasError || initialCommand) {
        setTimeout(() => {
          if (hasError) {
            process.exitCode = 1;
          }
          exit();
        }, 100);
      }
    }
  }, [phase, initialCommand, logs, command, exit]);

  // Handle exit on 'q' or Escape in interactive mode
  useInput((input, key) => {
    if (phase === "done" && !initialCommand) {
      if (input === "q" || key.escape) {
        exit();
      } else if (key.return) {
        // Reset to command selection
        setCommand(null);
        setPhase("select");
        setLogs([]);
        setMigrationName(null);
      }
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      {phase === "select" && (
        <>
          <Box marginBottom={1}>
            <Text bold color="cyan">zenstack-kit</Text>
            <Text dimColor> - Select a command</Text>
          </Box>
          <SelectInput items={commands} onSelect={handleSelect} />
        </>
      )}

      {command === "help" && <HelpDisplay />}

      {logs.map((l, i) => (
        <Status key={i} type={l.type} message={l.message} />
      ))}

      {phase === "done" && command !== "help" && !initialCommand && !logs.some((l) => l.type === "error") && (
        <Box marginTop={1}>
          <Text dimColor>Press Enter to continue, 'q' or Escape to exit</Text>
        </Box>
      )}
    </Box>
  );
}

function printHelpText() {
  const lines = [
    "zenstack-kit",
    "Database tooling for ZenStack schemas",
    "",
    "Commands:",
    "  migrate create   Generate a new SQL migration file",
    "  migrate apply    Apply pending SQL migrations",
    "  migrate rehash   Rebuild migration log checksums",
    "  init             Initialize snapshot from existing schema",
    "  pull             Introspect database and generate schema",
    "  help             Show help information",
    "",
    "Options:",
    "  -s, --schema <path>     Path to ZenStack schema",
    "  -m, --migrations <path> Migrations directory",
    "  -n, --name <name>       Migration name",
    "  --dialect <dialect>     Database dialect (sqlite, postgres, mysql)",
    "  --url <url>             Database connection URL",
    "  --migration <name>      Target a single migration (rehash only)",
    "  --no-ui                 Disable Ink UI (useful for CI/non-TTY)",
    "  --create-initial        Create initial migration (skip prompt)",
    "  --baseline              Create baseline only (skip prompt)",
    "  --preview               Preview pending migrations without applying",
    "  --mark-applied          Mark pending migrations as applied without running SQL",
    "  -f, --force             Force operation without confirmation",
    "  -c, --config <path>     Path to zenstack-kit config file",
  ];
  console.log(lines.join("\n"));
}

async function runCommandDirect(command: Command, options: CommandOptions) {
  const log: LogFn = (type, message) => {
    const prefix = type === "error" ? "✗" : type === "success" ? "✓" : type === "warning" ? "⚠" : "ℹ";
    const line = `${prefix} ${message}`;
    if (type === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  const ctx: CommandContext = {
    cwd: process.cwd(),
    options,
    log,
  };

  try {
    if (command === "migrate create") {
      await runMigrateGenerate(ctx);
    } else if (command === "migrate apply") {
      await runMigrateApply(ctx);
    } else if (command === "migrate rehash") {
      await runMigrateRehash(ctx);
    } else if (command === "init") {
      await runInit(ctx);
    } else if (command === "pull") {
      await runPull(ctx);
    }
  } catch (err) {
    if (err instanceof CommandError) {
      log("error", err.message);
    } else {
      log("error", `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

// Entry point
export function runCli() {
  const { command, options } = parseArgs();
  const isInteractive = Boolean(process.stdout.isTTY) && !options.noUi;

  // Show version
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log("0.1.0");
    process.exit(0);
  }

  // Show help if no command or --help/-h flag
  if (!command || process.argv.includes("--help") || process.argv.includes("-h")) {
    if (isInteractive) {
      const { waitUntilExit } = render(<HelpDisplay />);
      waitUntilExit().then(() => process.exit(0));
    } else {
      printHelpText();
    }
    return;
  }

  if (!isInteractive) {
    void runCommandDirect(command, options);
    return;
  }

  const { waitUntilExit } = render(<CliApp initialCommand={command} options={options} />);
  waitUntilExit();
}

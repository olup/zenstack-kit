/**
 * Interactive prompts for the init command using ink
 */

import React, { useState } from "react";
import { render, Box, Text } from "ink";
import SelectInput from "ink-select-input";

export type InitChoice = "skip" | "reinitialize" | "baseline" | "create_initial";
export type ConfirmChoice = "yes" | "no";

interface SelectPromptProps<T extends string> {
  message: string;
  items: Array<{ label: string; value: T; description?: string }>;
  onSelect: (value: T) => void;
}

function SelectPrompt<T extends string>({ message, items, onSelect }: SelectPromptProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleSelect = (item: { value: T }) => {
    onSelect(item.value);
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan">? </Text>
        <Text>{message}</Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={handleSelect}
        onHighlight={(item) => {
          const idx = items.findIndex((i) => i.value === item.value);
          if (idx !== -1) setSelectedIndex(idx);
        }}
      />
      {items[selectedIndex]?.description && (
        <Box marginTop={1}>
          <Text dimColor>  {items[selectedIndex].description}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Prompt user when snapshot already exists (Case A)
 */
export async function promptSnapshotExists(): Promise<InitChoice> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <SelectPrompt<InitChoice>
        message="Snapshot already exists. What would you like to do?"
        items={[
          {
            label: "Skip",
            value: "skip",
            description: "Do nothing and exit",
          },
          {
            label: "Reinitialize",
            value: "reinitialize",
            description: "Overwrite snapshot and rebuild migration log from existing migrations",
          },
        ]}
        onSelect={(value) => {
          unmount();
          resolve(value);
        }}
      />
    );
    waitUntilExit();
  });
}

/**
 * Prompt user for fresh init when no migrations exist (Case C)
 */
export async function promptFreshInit(): Promise<InitChoice> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <SelectPrompt<InitChoice>
        message="No migrations found. What would you like to do?"
        items={[
          {
            label: "Baseline only",
            value: "baseline",
            description: "Create snapshot only - use when database already matches schema",
          },
          {
            label: "Create initial migration",
            value: "create_initial",
            description: "Create snapshot + initial migration - use when database is empty",
          },
        ]}
        onSelect={(value) => {
          unmount();
          resolve(value);
        }}
      />
    );
    waitUntilExit();
  });
}

/**
 * Prompt user to confirm overwriting existing files during pull
 */
export async function promptPullConfirm(existingFiles: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="yellow">⚠ </Text>
          <Text>Existing files will be affected. Continue?</Text>
        </Box>
        <SelectPrompt<ConfirmChoice>
          message=""
          items={[
            {
              label: "No, abort",
              value: "no",
              description: "Cancel and keep existing files",
            },
            {
              label: "Yes, continue",
              value: "yes",
              description: "Overwrite schema file (migrations will not be deleted)",
            },
          ]}
          onSelect={(value) => {
            unmount();
            resolve(value === "yes");
          }}
        />
      </Box>
    );
    waitUntilExit();
  });
}

export type RenameChoice = "rename" | "delete_create";

/**
 * Text input component for prompting user input
 */
function TextInputPrompt({
  message,
  placeholder,
  onSubmit,
}: {
  message: string;
  placeholder: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = React.useState("");

  const handleInput = (input: string, key: { return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean }) => {
    if (key.return) {
      onSubmit(value.trim() || placeholder);
    } else if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta && input) {
      setValue((prev) => prev + input);
    }
  };

  // Use ink's useInput hook
  const { useInput } = require("ink");
  useInput(handleInput);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">? </Text>
        <Text>{message} </Text>
        <Text dimColor>({placeholder}): </Text>
        <Text>{value}</Text>
        <Text color="gray">█</Text>
      </Box>
    </Box>
  );
}

/**
 * Prompt user for migration name
 */
export async function promptMigrationName(defaultName: string = "migration"): Promise<string> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <TextInputPrompt
        message="Migration name"
        placeholder={defaultName}
        onSubmit={(value) => {
          unmount();
          resolve(value);
        }}
      />
    );
    waitUntilExit();
  });
}

export type MigrationConfirmChoice = "create" | "cancel";

/**
 * Prompt user to confirm migration creation
 */
export async function promptMigrationConfirm(migrationPath: string): Promise<MigrationConfirmChoice> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="cyan">? </Text>
          <Text>Create migration at:</Text>
        </Box>
        <Box marginBottom={1} marginLeft={2}>
          <Text color="yellow">{migrationPath}</Text>
        </Box>
        <SelectPrompt<MigrationConfirmChoice>
          message=""
          items={[
            {
              label: "Create migration",
              value: "create",
              description: "Generate the migration file",
            },
            {
              label: "Cancel",
              value: "cancel",
              description: "Abort without creating migration",
            },
          ]}
          onSelect={(value) => {
            unmount();
            resolve(value);
          }}
        />
      </Box>
    );
    waitUntilExit();
  });
}

/**
 * Prompt user to disambiguate a potential table rename
 */
export async function promptTableRename(from: string, to: string): Promise<RenameChoice> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <SelectPrompt<RenameChoice>
        message={`Table "${from}" was removed and "${to}" was added. Is this a rename?`}
        items={[
          {
            label: `Rename "${from}" to "${to}"`,
            value: "rename",
            description: "Preserve data by renaming the table",
          },
          {
            label: `Delete "${from}" and create "${to}"`,
            value: "delete_create",
            description: "Drop the old table and create a new one (data will be lost)",
          },
        ]}
        onSelect={(value) => {
          unmount();
          resolve(value);
        }}
      />
    );
    waitUntilExit();
  });
}

/**
 * Prompt user to disambiguate a potential column rename
 */
export async function promptColumnRename(
  table: string,
  from: string,
  to: string
): Promise<RenameChoice> {
  return new Promise((resolve) => {
    const { unmount, waitUntilExit } = render(
      <SelectPrompt<RenameChoice>
        message={`Column "${from}" was removed and "${to}" was added in table "${table}". Is this a rename?`}
        items={[
          {
            label: `Rename "${from}" to "${to}"`,
            value: "rename",
            description: "Preserve data by renaming the column",
          },
          {
            label: `Delete "${from}" and create "${to}"`,
            value: "delete_create",
            description: "Drop the old column and create a new one (data will be lost)",
          },
        ]}
        onSelect={(value) => {
          unmount();
          resolve(value);
        }}
      />
    );
    waitUntilExit();
  });
}

/**
 * Interactive prompts for the init command using ink
 */

import React, { useState } from "react";
import { render, Box, Text } from "ink";
import SelectInput from "ink-select-input";

export type InitChoice = "skip" | "reinitialize" | "baseline" | "create_initial";

interface SelectPromptProps {
  message: string;
  items: Array<{ label: string; value: InitChoice; description?: string }>;
  onSelect: (value: InitChoice) => void;
}

function SelectPrompt({ message, items, onSelect }: SelectPromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleSelect = (item: { value: InitChoice }) => {
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
      <SelectPrompt
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
      <SelectPrompt
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

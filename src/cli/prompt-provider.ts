/**
 * Prompt utilities with injectable provider for tests.
 */

import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

export interface PromptProvider {
  question(message: string): Promise<string>;
}

export function createDefaultPromptProvider(): PromptProvider {
  return {
    async question(message: string) {
      const rl = createInterface({ input, output });
      const answer = await rl.question(message);
      rl.close();
      return answer;
    },
  };
}

let currentProvider: PromptProvider | null = null;

export function setPromptProvider(provider: PromptProvider | null): void {
  currentProvider = provider;
}

export function getPromptProvider(): PromptProvider {
  if (currentProvider) {
    return currentProvider;
  }

  const envAnswers = process.env.ZENSTACK_KIT_PROMPT_ANSWERS;
  if (envAnswers) {
    try {
      const parsed = JSON.parse(envAnswers) as string[];
      const queue = Array.isArray(parsed) ? [...parsed] : [];
      currentProvider = {
        async question() {
          return queue.shift() ?? "";
        },
      };
      return currentProvider;
    } catch {
      return createDefaultPromptProvider();
    }
  }

  return createDefaultPromptProvider();
}

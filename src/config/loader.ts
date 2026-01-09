/**
 * Configuration loader for zenstack-kit
 */

import * as fs from "fs";
import * as path from "path";
import type { ZenStackKitConfig } from "./index.js";
import { createRequire } from "module";

const CONFIG_FILES = [
  "zenstack-kit.config.ts",
  "zenstack-kit.config.js",
  "zenstack-kit.config.mjs",
  "zenstack-kit.config.cjs",
];

export interface LoadedConfig {
  config: ZenStackKitConfig;
  configPath: string;
  configDir: string;
}

export async function loadConfig(cwd: string, configPath?: string): Promise<LoadedConfig | null> {
  const resolvedConfigPath = configPath ? path.resolve(cwd, configPath) : null;
  const configPathToLoad =
    resolvedConfigPath ??
    CONFIG_FILES.map((file) => path.join(cwd, file)).find((file) => fs.existsSync(file));
  if (!configPathToLoad) {
    return null;
  }

  const ext = path.extname(configPathToLoad);
  let config: ZenStackKitConfig;

  if (ext === ".cjs") {
    const require = createRequire(import.meta.url);
    const loaded = require(configPathToLoad);
    config = (loaded.default ?? loaded) as ZenStackKitConfig;
  } else if (ext === ".js" || ext === ".mjs") {
    const loaded = await import(pathToFileUrl(configPathToLoad));
    config = (loaded.default ?? loaded) as ZenStackKitConfig;
  } else {
    const { default: jiti } = await import("jiti");
    const loader = jiti(import.meta.url, { interopDefault: true });
    const loaded = loader(configPathToLoad);
    config = (loaded.default ?? loaded) as ZenStackKitConfig;
  }

  return {
    config,
    configPath: configPathToLoad,
    configDir: path.dirname(configPathToLoad),
  };
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  return new URL(`file://${resolved}`).href;
}

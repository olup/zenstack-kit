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

export async function loadConfig(cwd: string): Promise<LoadedConfig | null> {
  const configPath = CONFIG_FILES.map((file) => path.join(cwd, file)).find((file) => fs.existsSync(file));
  if (!configPath) {
    return null;
  }

  const ext = path.extname(configPath);
  let config: ZenStackKitConfig;

  if (ext === ".cjs") {
    const require = createRequire(import.meta.url);
    const loaded = require(configPath);
    config = (loaded.default ?? loaded) as ZenStackKitConfig;
  } else if (ext === ".js" || ext === ".mjs") {
    const loaded = await import(pathToFileUrl(configPath));
    config = (loaded.default ?? loaded) as ZenStackKitConfig;
  } else {
    const { default: jiti } = await import("jiti");
    const loader = jiti(import.meta.url, { interopDefault: true });
    const loaded = loader(configPath);
    config = (loaded.default ?? loaded) as ZenStackKitConfig;
  }

  return {
    config,
    configPath,
    configDir: path.dirname(configPath),
  };
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  return new URL(`file://${resolved}`).href;
}

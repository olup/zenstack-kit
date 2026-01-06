/**
 * Configuration loader for zenstack-kit
 */

import * as fs from "fs";
import * as path from "path";
import type { ZenStackKitConfig } from "./config.js";
import { createRequire } from "module";

const CONFIG_FILES = [
  "zenstack-kit.config.ts",
  "zenstack-kit.config.js",
  "zenstack-kit.config.mjs",
  "zenstack-kit.config.cjs",
];

export async function loadConfig(cwd: string): Promise<ZenStackKitConfig | null> {
  const configPath = CONFIG_FILES.map((file) => path.join(cwd, file)).find((file) => fs.existsSync(file));
  if (!configPath) {
    return null;
  }

  const ext = path.extname(configPath);

  if (ext === ".cjs") {
    const require = createRequire(import.meta.url);
    const loaded = require(configPath);
    return (loaded.default ?? loaded) as ZenStackKitConfig;
  }

  if (ext === ".js" || ext === ".mjs") {
    const loaded = await import(pathToFileUrl(configPath));
    return (loaded.default ?? loaded) as ZenStackKitConfig;
  }

  const { default: jiti } = await import("jiti");
  const loader = jiti(import.meta.url, { interopDefault: true });
  const loaded = loader(configPath);
  return (loaded.default ?? loaded) as ZenStackKitConfig;
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  return new URL(`file://${resolved}`).href;
}

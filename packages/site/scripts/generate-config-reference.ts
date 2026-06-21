/**
 * Generate the config & environment reference from the Council CLI's Zod
 * `ConfigSchema`.
 *
 * Run via `pnpm --filter @council-ai/site docs:generate:config`. This is the
 * single source of truth for `src/content/docs/reference/config-reference.mdx`
 * and `src/generated/config.json`; never hand-edit those files.
 *
 * `ConfigSchema` is imported directly from the CLI's schema source and turned
 * into a JSON Schema via Zod's own `toJSONSchema()` introspection. That JSON
 * Schema — plain data — is the only thing handed to the renderer, so nothing
 * under `src/` ever imports the CLI or Zod and the site bundle stays CLI-free.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigSchema } from "../../cli/src/config/schema.ts";

import {
  buildConfigModel,
  type ConfigModel,
  type JsonSchemaNode,
} from "../src/lib/reference/config-model.ts";
import { CONFIG_DESCRIPTIONS, ENV_VARS } from "../src/lib/reference/config-metadata.ts";
import { type GeneratedFile, renderConfigReference } from "../src/lib/reference/config-render.ts";

/** Absolute path to the `packages/site` package root. */
export const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Introspect the real `ConfigSchema` into a plain JSON Schema model. */
export function getConfigJsonSchema(): JsonSchemaNode {
  return ConfigSchema.toJSONSchema() as unknown as JsonSchemaNode;
}

/** Build the reference model from the real schema and curated metadata. */
export function buildReferenceModel(): ConfigModel {
  return buildConfigModel(getConfigJsonSchema(), CONFIG_DESCRIPTIONS, ENV_VARS);
}

/** Build the full set of generated files in memory. */
export function collectConfigReferenceFiles(): readonly GeneratedFile[] {
  return renderConfigReference(buildReferenceModel());
}

/** Write generated files to disk, creating parent directories as needed. */
export function writeConfigReferenceFiles(files: readonly GeneratedFile[]): void {
  for (const file of files) {
    const absolute = path.join(SITE_ROOT, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.contents);
  }
}

function main(): void {
  const files = collectConfigReferenceFiles();
  writeConfigReferenceFiles(files);
  process.stdout.write(`Generated ${files.length} config-reference file(s).\n`);
  for (const file of files) {
    process.stdout.write(`  ${file.path}\n`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}

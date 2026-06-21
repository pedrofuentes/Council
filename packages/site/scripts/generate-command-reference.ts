/**
 * Generate the CLI command reference from the Council CLI's Commander program.
 *
 * Run via `pnpm --filter @council-ai/site docs:generate:commands`. This is the
 * single source of truth for `src/content/docs/reference/commands/*.md` and
 * `src/generated/commands.json`; never hand-edit those files.
 *
 * `buildProgram()` is imported from the built `@council-ai/cli` package, so the
 * CLI must be built first (`pnpm --filter @council-ai/cli build`). Importing it
 * only constructs the Commander program — it never parses argv or runs the CLI.
 * The CLI dependency is confined to these scripts: nothing under `src/` imports
 * it, so the site bundle stays CLI-free.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProgram } from "@council-ai/cli";

import { buildCommandModel } from "../src/lib/reference/command-model.ts";
import { type GeneratedFile, renderReference } from "../src/lib/reference/render.ts";

/** Absolute path to the `packages/site` package root. */
export const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Build the full set of generated files in memory. */
export function collectReferenceFiles(): readonly GeneratedFile[] {
  return renderReference(buildCommandModel(buildProgram()));
}

/** Write generated files to disk, creating parent directories as needed. */
export function writeReferenceFiles(files: readonly GeneratedFile[]): void {
  for (const file of files) {
    const absolute = path.join(SITE_ROOT, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.contents);
  }
}

function main(): void {
  const files = collectReferenceFiles();
  writeReferenceFiles(files);
  process.stdout.write(`Generated ${files.length} command-reference file(s).\n`);
  for (const file of files) {
    process.stdout.write(`  ${file.path}\n`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}

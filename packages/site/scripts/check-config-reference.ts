/**
 * Drift check for the generated config & environment reference.
 *
 * Run via `pnpm --filter @council-ai/site docs:check:config`. Regenerates the
 * reference in memory (no temp files) and compares it against the committed
 * files. Exits non-zero — with instructions — if anything is missing or stale,
 * so CI fails when the docs drift from the CLI's Zod config schema.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { GeneratedFile } from "../src/lib/reference/config-render.ts";

import { collectConfigReferenceFiles, SITE_ROOT } from "./generate-config-reference.ts";

/**
 * Compare the expected generated files against actual contents, returning a
 * human-readable problem for each missing or stale file. `readActual` resolves a
 * generated file's relative path to its on-disk contents, or `undefined` if it
 * does not exist.
 */
export function findDriftedFiles(
  expected: readonly GeneratedFile[],
  readActual: (relativePath: string) => string | undefined,
): readonly string[] {
  const problems: string[] = [];
  for (const file of expected) {
    const actual = readActual(file.path);
    if (actual === undefined) {
      problems.push(`missing  ${file.path}`);
    } else if (actual !== file.contents) {
      problems.push(`outdated ${file.path}`);
    }
  }
  return problems;
}

function main(): void {
  const expected = collectConfigReferenceFiles();
  const problems = findDriftedFiles(expected, (relativePath) => {
    const absolute = path.join(SITE_ROOT, relativePath);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
  });

  if (problems.length > 0) {
    process.stderr.write(
      `Config reference is out of date:\n${problems.map((line) => `  - ${line}`).join("\n")}\n\n` +
        "Run `pnpm --filter @council-ai/site docs:generate:config` and commit the result.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Config reference is up to date (${expected.length} file(s)).\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}

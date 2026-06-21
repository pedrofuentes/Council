/**
 * Drift check for the generated CLI command reference.
 *
 * Run via `pnpm --filter @council-ai/site docs:check:commands`. Regenerates the
 * reference in memory (no temp files) and compares it against the committed
 * files. Exits non-zero — with instructions — if anything is missing, stale, or
 * orphaned, so CI fails when the docs drift from the CLI's Commander program.
 *
 * Requires the CLI to be built first (see generate-command-reference.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { collectReferenceFiles, SITE_ROOT } from "./generate-command-reference.ts";

const COMMANDS_DOC_DIR = "src/content/docs/reference/commands";

function main(): void {
  const expected = collectReferenceFiles();
  const problems: string[] = [];

  for (const file of expected) {
    const absolute = path.join(SITE_ROOT, file.path);
    if (!fs.existsSync(absolute)) {
      problems.push(`missing  ${file.path}`);
      continue;
    }
    if (fs.readFileSync(absolute, "utf8") !== file.contents) {
      problems.push(`outdated ${file.path}`);
    }
  }

  // Flag committed pages the generator would no longer emit (e.g. a command
  // that was renamed or removed in the CLI).
  const expectedPaths = new Set(expected.map((file) => path.join(SITE_ROOT, file.path)));
  const commandsDir = path.join(SITE_ROOT, COMMANDS_DOC_DIR);
  if (fs.existsSync(commandsDir)) {
    for (const entry of fs.readdirSync(commandsDir)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      if (!expectedPaths.has(path.join(commandsDir, entry))) {
        problems.push(`orphaned ${COMMANDS_DOC_DIR}/${entry}`);
      }
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      `Command reference is out of date:\n${problems.map((line) => `  - ${line}`).join("\n")}\n\n` +
        "Run `pnpm --filter @council-ai/site docs:generate:commands` and commit the result.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Command reference is up to date (${expected.length} file(s)).\n`);
}

main();

/**
 * Tests for `council panel lint` (T-library-1).
 *
 * The lint subcommand reads one or more panel YAML files (or every bundled
 * built-in via `--built-ins`), runs the pure `lintPanelDefinition` gate, prints
 * a rule-tagged report, and exits non-zero when any ERROR-severity finding is
 * present. Warnings are printed but never change the exit code — `--official`
 * promotes the quality warnings (filler phrases, missing sample prompts, slug
 * refs) to errors.
 *
 * RED at this commit: the `lint` subcommand does not yet exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";

const CLEAN_PANEL = `
name: clean-panel
description: A panel that pressure-tests platform decisions.
samplePrompts:
  - Should we adopt event sourcing for the orders service?
experts:
  - slug: backend
    displayName: Backend Engineer
    role: Backend systems engineer
    expertise:
      weightedEvidence:
        - Latency budgets under peak production load
        - Failure modes of queue backpressure
        - Schema migration safety on live tables
        - Idempotency of retried write operations
      referenceCases:
        - The cache stampede that took down checkout
        - The migration that locked the orders table
      notExpertIn:
        - frontend animation
        - tax accounting
    epistemicStance: You trust measurement over intuition.
  - slug: design
    displayName: Product Designer
    role: Product designer
    expertise:
      weightedEvidence:
        - Friction in first-run onboarding
        - Information scent in navigation
        - Error-state clarity
        - Accessibility of core flows
      referenceCases:
        - The signup form that lost half its users at step three
        - The settings page nobody could find
      notExpertIn:
        - database internals
        - capacity planning
    epistemicStance: You start from the user's confusion, not the feature list.
  - slug: privacy
    displayName: Privacy Specialist
    role: Data privacy specialist
    expertise:
      weightedEvidence:
        - Data minimization at collection time
        - Retention and deletion guarantees
        - Cross-border transfer constraints
        - Consent provenance and auditability
      referenceCases:
        - The analytics SDK that exfiltrated device identifiers
        - The export that included soft-deleted rows
      notExpertIn:
        - frontend animation
        - load testing
    epistemicStance: You assume any field collected will eventually leak.
`;

/** A panel where one expert has only 3 weightedEvidence entries (< 4 → error). */
const STRUCTURALLY_INVALID_PANEL = CLEAN_PANEL.replace(
  "        - Idempotency of retried write operations\n",
  "",
);

interface TempDir {
  readonly dir: string;
}

async function makeTempDir(): Promise<TempDir> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-lint-"));
  return { dir };
}

async function writeFile(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, content, "utf-8");
  return file;
}

function lintCommand(): {
  parse: (args: readonly string[]) => Promise<void>;
  out: () => string;
  err: () => string;
} {
  let stdout = "";
  let stderr = "";
  const cmd = buildPanelCommand(
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );
  return {
    parse: async (args) => {
      await cmd.parseAsync(["node", "council-panel", "lint", ...args]);
    },
    out: () => stdout,
    err: () => stderr,
  };
}

describe("council panel lint", () => {
  let tmp: TempDir;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("is registered as a panel subcommand", () => {
    const subs = buildPanelCommand().commands.map((c) => c.name());
    expect(subs).toContain("lint");
  });

  it("exits cleanly (no throw) for a structurally valid panel", async () => {
    const file = await writeFile(tmp.dir, "clean.yaml", CLEAN_PANEL);
    const cli = lintCommand();
    await expect(cli.parse([file])).resolves.toBeUndefined();
    expect(cli.out()).toMatch(/clean\.yaml/);
  });

  it("fails (throws) and prints the rule id for a structural error", async () => {
    const file = await writeFile(tmp.dir, "bad.yaml", STRUCTURALLY_INVALID_PANEL);
    const cli = lintCommand();
    await expect(cli.parse([file])).rejects.toThrow();
    expect(cli.out() + cli.err()).toContain("expert-evidence");
  });

  it("reports a YAML parse error as a failure", async () => {
    const file = await writeFile(tmp.dir, "broken.yaml", "name: [unterminated\n");
    const cli = lintCommand();
    await expect(cli.parse([file])).rejects.toThrow();
    expect(cli.out() + cli.err()).toMatch(/broken\.yaml/);
  });

  it("fails when a target file does not exist", async () => {
    const cli = lintCommand();
    await expect(cli.parse([path.join(tmp.dir, "nope.yaml")])).rejects.toThrow();
  });

  it("fails when neither files nor --built-ins are provided", async () => {
    const cli = lintCommand();
    await expect(cli.parse([])).rejects.toThrow();
  });

  it("lints every built-in panel and passes in default (non-official) mode", async () => {
    const cli = lintCommand();
    // The 5 shipped panels are not yet normalized (no samplePrompts), but in
    // default mode those are warnings — so the gate must still pass.
    await expect(cli.parse(["--built-ins"])).resolves.toBeUndefined();
    expect(cli.out()).toContain("code-review");
  });

  it("fails the built-ins under --official (they are not normalized yet)", async () => {
    const cli = lintCommand();
    await expect(cli.parse(["--built-ins", "--official"])).rejects.toThrow();
  });

  it("promotes warnings to errors for a single file under --official", async () => {
    // Clean panel minus its samplePrompts → only a warning by default, an error
    // under --official.
    const noPrompts = CLEAN_PANEL.replace(
      /samplePrompts:\n {2}- .*\n/,
      "",
    );
    const file = await writeFile(tmp.dir, "no-prompts.yaml", noPrompts);

    const ok = lintCommand();
    await expect(ok.parse([file])).resolves.toBeUndefined();

    const strict = lintCommand();
    await expect(strict.parse(["--official", file])).rejects.toThrow();
    expect(strict.out() + strict.err()).toContain("sample-prompts");
  });
});

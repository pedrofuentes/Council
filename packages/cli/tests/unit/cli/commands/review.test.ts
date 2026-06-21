/**
 * Tests for `council review` — run the built-in code-review expert panel
 * over a diff and print the review (T-ecosystem-7).
 *
 * The diff source is one of: `--diff-file <path>`, `--diff-file -` (stdin),
 * or the default `git diff <base>` (base defaults to HEAD). The command
 * reuses the convene/engine path: it loads the built-in `code-review`
 * template, builds expert system prompts, persists panel + expert rows, and
 * streams the debate through the shared `runWithEngine()` helper.
 *
 * Tests inject a MockEngine via the `engineFactory` option (and a `gitDiff`
 * seam for the default path) so the command is exercised fully offline —
 * no Copilot SDK, no network, no auth.
 *
 * RED at this commit: src/cli/commands/review.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildReviewCommand } from "../../../../src/cli/commands/review.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// A small, deterministic unified diff with a unique marker so tests can
// assert the diff actually reached the engine (i.e. the panel reviewed it).
const REVIEW_MARKER = "REVIEW_MARKER_9f3a";
const SAMPLE_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,3 +1,4 @@",
  " export function login(user: string): boolean {",
  `+  console.log(\`logging in \${user}\`); // ${REVIEW_MARKER}`,
  "   return true;",
  " }",
].join("\n");

// The four built-in code-review experts (packages/cli/panels/code-review.yaml).
const CODE_REVIEW_SLUGS = ["senior", "security", "perf", "maintainer"] as const;

describe("buildReviewCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-review-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    setQuiet(false);
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  /** Factory that records the most recently constructed MockEngine. */
  function makeRecordingMockFactory(): {
    factory: () => CouncilEngine;
    last: () => MockEngine | undefined;
  } {
    let last: MockEngine | undefined;
    return {
      factory: () => {
        last = new MockEngine({ responses: {} });
        return last;
      },
      last: () => last,
    };
  }

  async function writeDiffFile(contents: string): Promise<string> {
    const p = path.join(testHome, "changes.diff");
    await fs.writeFile(p, contents, "utf-8");
    return p;
  }

  it("registers a 'review' command with the expected diff-source + engine options", () => {
    const cmd = buildReviewCommand({ engineFactory: makeRecordingMockFactory().factory });
    expect(cmd.name()).toBe("review");
    expect(cmd.description()).toMatch(/review|diff|code/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--diff-file");
    expect(longs).toContain("--base");
    expect(longs).toContain("--engine");
    expect(longs).toContain("--format");
    expect(longs).toContain("--max-rounds");
  });

  it("--help is explicit that the diff is sent to the configured AI engine", () => {
    const cmd = buildReviewCommand({ engineFactory: makeRecordingMockFactory().factory });
    const help = cmd.helpInformation();
    expect(help).toMatch(/sent/i);
    expect(help).toMatch(/engine/i);
    expect(help).toMatch(/diff/i);
  });

  it("reads a diff from a file and runs the code-review panel fully offline (mock)", async () => {
    const diffPath = await writeDiffFile(SAMPLE_DIFF);
    const rec = makeRecordingMockFactory();
    let captured = "";
    const cmd = buildReviewCommand({
      engineFactory: rec.factory,
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-review",
      "--diff-file",
      diffPath,
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
    ]);

    // Engine was a MockEngine (no Copilot SDK) and received the diff.
    const engine = rec.last();
    expect(engine).toBeInstanceOf(MockEngine);
    expect(engine?.sentPrompts.some((p) => p.prompt.includes(REVIEW_MARKER))).toBe(true);

    // NDJSON stream: the panel assembled with all four code-review experts,
    // every expert produced a turn, and the stream terminates with debate.end.
    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { kind: string; expertSlug?: string });
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");

    const turnSlugs = new Set(events.filter((e) => e.kind === "turn.end").map((e) => e.expertSlug));
    for (const slug of CODE_REVIEW_SLUGS) {
      expect(turnSlugs).toContain(slug);
    }

    // Side effects: a panel with experts and a completed debate were persisted.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const panelId = panels[0]?.id ?? "";
      const experts = await new ExpertRepository(db).findByPanelId(panelId);
      expect(experts.length).toBe(CODE_REVIEW_SLUGS.length);
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      expect(debates[0]?.status).toBe("completed");
    } finally {
      await db.destroy();
    }
  });

  it("reads a diff from stdin via `--diff-file -`", async () => {
    const rec = makeRecordingMockFactory();
    let captured = "";
    const cmd = buildReviewCommand({
      engineFactory: rec.factory,
      readStdin: async () => SAMPLE_DIFF,
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-review",
      "--diff-file",
      "-",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
    ]);

    expect(rec.last()?.sentPrompts.some((p) => p.prompt.includes(REVIEW_MARKER))).toBe(true);
    const kinds = captured
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("works offline with the real provider path when --engine mock (no factory injected)", async () => {
    const diffPath = await writeDiffFile(SAMPLE_DIFF);
    let captured = "";
    const cmd = buildReviewCommand({
      // No engineFactory: exercises makeEngineFromKind("mock") → MockEngine.
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-review",
      "--diff-file",
      diffPath,
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
    ]);

    const kinds = captured
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("--format plain produces human-readable output naming the code-review experts", async () => {
    const diffPath = await writeDiffFile(SAMPLE_DIFF);
    let captured = "";
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-review",
      "--diff-file",
      diffPath,
      "--engine",
      "mock",
      "--max-rounds",
      "1",
    ]);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured).not.toMatch(/^\{/);
    expect(captured).toMatch(/Senior Developer|Security Auditor|Panel assembled/);
  });

  it("defaults to `git diff HEAD` when no --diff-file is given", async () => {
    const rec = makeRecordingMockFactory();
    const baseCalls: string[] = [];
    const cmd = buildReviewCommand({
      engineFactory: rec.factory,
      gitDiff: async (base: string) => {
        baseCalls.push(base);
        return SAMPLE_DIFF;
      },
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-review",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
    ]);

    expect(baseCalls).toEqual(["HEAD"]);
    expect(rec.last()?.sentPrompts.some((p) => p.prompt.includes(REVIEW_MARKER))).toBe(true);
  });

  it("passes --base <ref> through to the git diff runner", async () => {
    const baseCalls: string[] = [];
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      gitDiff: async (base: string) => {
        baseCalls.push(base);
        return SAMPLE_DIFF;
      },
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-review",
      "--base",
      "main",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
    ]);

    expect(baseCalls).toEqual(["main"]);
  });

  it("rejects an empty diff file with a clear error and non-zero exit", async () => {
    const diffPath = await writeDiffFile("");
    let errText = "";
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      write: () => undefined,
      writeError: (s) => {
        errText += s;
      },
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync(["node", "council-review", "--diff-file", diffPath, "--engine", "mock"]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliUserError);
    expect(errText.toLowerCase()).toMatch(/empty|no diff|no changes/);
  });

  it("rejects a whitespace-only stdin diff", async () => {
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      readStdin: async () => "   \n\t  \n",
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync(["node", "council-review", "--diff-file", "-", "--engine", "mock"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliUserError);
  });

  it("rejects when the default git diff is empty (no local changes)", async () => {
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      gitDiff: async () => "",
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync(["node", "council-review", "--engine", "mock"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliUserError);
  });

  it("rejects a missing --diff-file path with a clear error", async () => {
    const missing = path.join(testHome, "does-not-exist.diff");
    let errText = "";
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      write: () => undefined,
      writeError: (s) => {
        errText += s;
      },
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync(["node", "council-review", "--diff-file", missing, "--engine", "mock"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliUserError);
    expect(errText.toLowerCase()).toMatch(/not found|could not read/);
  });

  it("rejects an invalid --engine value", async () => {
    const diffPath = await writeDiffFile(SAMPLE_DIFF);
    const cmd = buildReviewCommand({
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-review", "--diff-file", diffPath, "--engine", "nope"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/unknown.*engine|allowed choices|mock/);
  });
});

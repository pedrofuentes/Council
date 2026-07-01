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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TemplateLoaderModule from "../../../../src/core/template-loader.js";

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

// Regex matching codepoints that toSingleLineDisplay must strip from any
// single-line display context (ANSI/C1 controls, Bidi overrides, line seps).
// eslint-disable-next-line no-control-regex
const DANGEROUS_CODEPOINTS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

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

  it("rejects a --base value starting with dash (argument injection protection)", async () => {
    let errText = "";
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      gitDiff: async (_base: string) => {
        // If we reach here with a malicious base, the current code is vulnerable.
        // The fix should either reject the base before calling gitDiff, or pass
        // --end-of-options so git treats it as a ref (which then fails as unknown).
        return SAMPLE_DIFF;
      },
      write: () => undefined,
      writeError: (s) => {
        errText += s;
      },
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync([
        "node",
        "council-review",
        "--base",
        "--output=/tmp/evil",
        "--engine",
        "mock",
        "--max-rounds",
        "1",
      ]);
    } catch (err) {
      thrown = err;
    }

    // The malicious --base must be rejected with a clear CliUserError explaining
    // that --base must be a git ref, not an option starting with dash.
    expect(thrown).toBeInstanceOf(CliUserError);
    expect(errText.toLowerCase()).toContain("--base argument must be a git ref");
  });

  it("rejects other dash-prefixed --base values (e.g., --ext-diff)", async () => {
    const cmd = buildReviewCommand({
      engineFactory: makeRecordingMockFactory().factory,
      gitDiff: async (_base: string) => SAMPLE_DIFF,
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync(["node", "council-review", "--base", "--ext-diff", "--engine", "mock"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliUserError);
  });

  // ---------------------------------------------------------------------------
  // #1421 — regression: defaultGitDiff must pass --end-of-options to execFile
  // ---------------------------------------------------------------------------
  it("defaultGitDiff invokes execFile with ['diff', '--end-of-options', <base>] (defense-in-depth)", async () => {
    // This test does NOT inject the gitDiff seam so defaultGitDiff runs, which
    // calls execFile("git", ["diff", "--end-of-options", base], ...).
    // If --end-of-options is removed from the src, capturedArgs[1] would be
    // ["diff", "main"] and the assertion below would fail.
    vi.resetModules();
    const capturedCalls: { cmd: unknown; args: unknown }[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (...args: unknown[]) => {
        capturedCalls.push({ cmd: args[0], args: args[1] });
        const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
        // Simulate async callback with the sample diff so the command succeeds.
        setTimeout(() => cb(null, SAMPLE_DIFF, ""), 0);
      },
    }));

    const { buildReviewCommand: build } = await import("../../../../src/cli/commands/review.js");

    const cmd = build({
      engineFactory: makeRecordingMockFactory().factory,
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

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]?.cmd).toBe("git");
    // The --end-of-options sentinel must be present so `main` cannot be
    // misinterpreted as a git option even if the caller-side dash check were
    // bypassed.
    expect(capturedCalls[0]?.args).toEqual(["diff", "--end-of-options", "main"]);

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // #1484 — regression: review preamble sinks sanitize adversarial template
  //         data (toSingleLineDisplay on template.name and e.displayName)
  // ---------------------------------------------------------------------------
  it("preamble sanitizes adversarial bytes in template.name (toSingleLineDisplay)", async () => {
    // Adversarial template name containing ANSI CSI, C1 CSI (U+009B),
    // CR/LF, Unicode line/paragraph separators, and Bidi override chars.
    // If toSingleLineDisplay were removed from the preamble write, these bytes
    // would appear raw in the captured output and the assertion below would fail.
    const evilName = "code-review\x1B[2J\r\nINJECTED\u009B5m\u2028PARA\u202aRLO";

    vi.resetModules();
    vi.doMock("../../../../src/core/template-loader.js", async (importOriginal) => {
      const actual = await importOriginal<typeof TemplateLoaderModule>();
      return {
        ...actual,
        loadTemplate: async () =>
          ({
            name: evilName,
            experts: [
              {
                slug: "reviewer",
                displayName: "Reviewer",
                role: "Code Reviewer",
                expertise: {
                  weightedEvidence: ["code quality"],
                  referenceCases: [],
                  notExpertIn: [],
                },
                epistemicStance: "Evidence-led",
                kind: "generic" as const,
              },
            ],
          }) satisfies TemplateLoaderModule.ResolvedPanelDefinition,
      };
    });

    const { buildReviewCommand: build } = await import("../../../../src/cli/commands/review.js");
    const diffPath = await writeDiffFile(SAMPLE_DIFF);
    let preamble = "";
    const cmd = build({
      engineFactory: makeRecordingMockFactory().factory,
      write: (s) => {
        preamble += s;
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

    // The preamble header must be present and free of all dangerous codepoints.
    // Using the plain renderer so preamble() is actually called (JSON renderer
    // skips the preamble to keep the stream machine-parseable).
    // Extract only the header line so the assertion regex (which includes \n)
    // is checked on a single-line string — the renderer's own newlines are not
    // part of the adversarial payload.
    const headerLine = preamble.match(/# Code review —[^\n]*/)?.[0] ?? "";
    expect(headerLine.length).toBeGreaterThan(0);
    expect(headerLine).not.toMatch(DANGEROUS_CODEPOINTS);

    vi.doUnmock("../../../../src/core/template-loader.js");
    vi.resetModules();
  });

  it("preamble sanitizes adversarial bytes in expert displayName (toSingleLineDisplay)", async () => {
    // Adversarial expert displayName with terminal-injection payloads.
    // A reversion removing toSingleLineDisplay from the experts line would let
    // these bytes reach the terminal and break the assertion below.
    const evilDisplay = "Reviewer\x1B[31mRED\x1B[0m\r\nHIJACKED\u009B\u2029PARA";

    vi.resetModules();
    vi.doMock("../../../../src/core/template-loader.js", async (importOriginal) => {
      const actual = await importOriginal<typeof TemplateLoaderModule>();
      return {
        ...actual,
        loadTemplate: async () =>
          ({
            name: "code-review",
            experts: [
              {
                slug: "evil-expert",
                displayName: evilDisplay,
                role: "Adversarial Reviewer",
                expertise: { weightedEvidence: ["injection"], referenceCases: [], notExpertIn: [] },
                epistemicStance: "Evidence-led",
                kind: "generic" as const,
              },
            ],
          }) satisfies TemplateLoaderModule.ResolvedPanelDefinition,
      };
    });

    const { buildReviewCommand: build } = await import("../../../../src/cli/commands/review.js");
    const diffPath = await writeDiffFile(SAMPLE_DIFF);
    let preamble = "";
    const cmd = build({
      engineFactory: makeRecordingMockFactory().factory,
      write: (s) => {
        preamble += s;
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

    // "Experts:" line must be present and must not leak any control/injection chars.
    // Plain renderer is used so the preamble() callback fires.
    // Extract just the "Experts:" line so the regex (which includes \n) is applied
    // to a single-line string and does not trip on the renderer's own newlines.
    const expertsLine = preamble.match(/Experts:[^\n]*/)?.[0] ?? "";
    expect(expertsLine.length).toBeGreaterThan(0);
    expect(expertsLine).not.toMatch(DANGEROUS_CODEPOINTS);

    vi.doUnmock("../../../../src/core/template-loader.js");
    vi.resetModules();
  });
});

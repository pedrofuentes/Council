/**
 * Tests for `council ask <saved-panel> "<question>"` — the non-interactive
 * (headless) saved-panel fallback (T-16b / F-11).
 *
 * Before this feature, `council ask` only accepted an active debate-session
 * handle; a saved/library kebab-case panel (or a built-in template such as
 * `code-review`) was rejected with a "matches a library template, not an
 * active session" message, leaving no non-interactive way to Q&A a saved
 * panel's documents (the interactive `chat` requires a TTY).
 *
 * RED at the test commit: `ask.ts` still rejects saved panels, so the
 * "answers headlessly" expectations fail.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as SavedPanelRuntime from "../../../../src/cli/commands/saved-panel-runtime.js";
import { buildAskCommand } from "../../../../src/cli/commands/ask.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Hoisted partial mock of the saved-panel runtime module. Every real export
// (loadSavedPanelExperts, scanPanelDocuments, …) is spread through so the other
// tests keep exercising the real implementation; only scanPanelDocuments is
// wrapped in a spy that delegates to the original by default. Individual tests
// override it with vi.mocked(scanPanelDocuments).mockRejectedValueOnce(...) to
// drive the best-effort RAG failure branch deterministically.
vi.mock("../../../../src/cli/commands/saved-panel-runtime.js", async (importOriginal) => {
  const real = (await importOriginal()) as typeof SavedPanelRuntime;
  return {
    ...real,
    scanPanelDocuments: vi.fn(real.scanPanelDocuments),
  };
});

// Static import — vi.mock is hoisted so this resolves to the mocked binding.
import { scanPanelDocuments } from "../../../../src/cli/commands/saved-panel-runtime.js";

const SAVED_PANEL_NAME = "saved-advisors";

const SAVED_PANEL_YAML = [
  `name: ${SAVED_PANEL_NAME}`,
  "description: A saved advisory panel",
  "experts:",
  "  - slug: strategist",
  "    displayName: Strategist",
  "    role: Strategic advisor focused on long-term planning",
  "    expertise:",
  "      weightedEvidence:",
  "        - Long-term planning trade-offs",
  "      referenceCases: []",
  "      notExpertIn: []",
  "    epistemicStance: Pragmatic and evidence-driven",
  "  - slug: analyst",
  "    displayName: Analyst",
  "    role: Quantitative data analyst",
  "    expertise:",
  "      weightedEvidence:",
  "        - Quantitative analysis",
  "      referenceCases: []",
  "      notExpertIn: []",
  "    epistemicStance: Rigorous and empirical",
].join("\n");

interface ParsedEvent {
  readonly kind: string;
  readonly expertSlug?: string;
}

function parseNdjson(stdout: string): ParsedEvent[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as ParsedEvent);
}

// Every codepoint class a terminal can be induced to (mis)interpret — used to
// assert the RAG scan/retrieval warning is stripped of ANSI/OSC/C0/C1/CR/bidi
// sequences before it reaches stderr.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// Each payload embeds a distinct terminal-injection vector plus a printable
// remnant that MUST survive sanitization (positive oracle — guards against an
// over-eager fix that empties the message).
const RAG_PAYLOADS: readonly {
  readonly label: string;
  readonly message: string;
  readonly remnant: string;
}[] = [
  { label: "ANSI CSI colour", message: "bad\x1b[31mINJECT\x1b[0m", remnant: "INJECT" },
  { label: "CR + LF", message: "bad\r\nINJECT", remnant: "INJECT" },
  { label: "CR overwrite", message: "Corrupt\rINJECT", remnant: "INJECT" },
  { label: "OSC set-title", message: "bad\x1b]0;pwned\x07 suffix", remnant: "suffix" },
  { label: "C1 CSI + bidi", message: "bad\u009b31m\u202eINJECT", remnant: "INJECT" },
];

describe("buildAskCommand — saved-panel headless fallback (F-11)", () => {
  let testHome: string;
  let dataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ask-saved-"));
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ask-saved-data-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = dataHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
    await fs.mkdir(path.join(dataHome, "panels"), { recursive: true });
    await fs.mkdir(path.join(dataHome, "experts"), { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    setQuiet(false);
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    for (const dir of [testHome, dataHome]) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    }
  });

  async function writeSavedPanel(): Promise<void> {
    await fs.writeFile(
      path.join(dataHome, "panels", `${SAVED_PANEL_NAME}.yaml`),
      SAVED_PANEL_YAML,
      "utf-8",
    );
  }

  async function writePanelDoc(fileName: string, content: string): Promise<void> {
    const docsDir = path.join(dataHome, "panels", SAVED_PANEL_NAME, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, fileName), content, "utf-8");
  }

  function makeMockEngineFactory(): () => CouncilEngine {
    return () => new MockEngine({ responses: {} });
  }

  /** A factory that returns ONE captured MockEngine so tests can inspect
   * the prompts it recorded via {@link MockEngine.sentPrompts}. */
  function makeRecordingEngine(): { factory: () => CouncilEngine; engine: () => MockEngine } {
    const engine = new MockEngine({ responses: {} });
    return { factory: () => engine, engine: () => engine };
  }

  it("answers a saved kebab-case panel headlessly with exactly one expert (exit 0)", async () => {
    await writeSavedPanel();
    let out = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        out += s;
      },
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      SAVED_PANEL_NAME,
      "What is our long-term strategy?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const events = parseNdjson(out);
    const kinds = events.map((e) => e.kind);
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(1); // exactly ONE expert answered
    expect(kinds[kinds.length - 1]).toBe("debate.end");

    // T-PR16 .3: The one-shot panel row is now cleaned up after ask completes,
    // so no panel should persist. Debates/turns are cascade-deleted.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("cleans up ephemeral one-shot panel row after ask completes (T-PR16 .3)", async () => {
    // T-PR16 .3: The one-shot saved-panel `ask` path creates a transient
    // runtime panel row for attribution. Prior to this fix, those rows
    // persisted, accumulating in `council sessions`. The intended behavior
    // (per #2430 .1) is that ephemeral one-shot rows should NOT pollute the
    // saved-panel roster. This test verifies cleanup after ask completes.
    await writeSavedPanel();
    let out = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        out += s;
      },
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      SAVED_PANEL_NAME,
      "What is our long-term strategy?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const events = parseNdjson(out);
    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(1);

    // After the one-shot ask completes, the ephemeral panel row should be
    // removed — no panel rows should remain.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("answers a built-in template (code-review) that is not an active session", async () => {
    // No user panel file for code-review — it must resolve as a built-in.
    let out = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        out += s;
      },
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      "code-review",
      "Any concerns with this diff?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const events = parseNdjson(out);
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("debate.end");
  });

  it("routes to the requested --expert slug", async () => {
    await writeSavedPanel();
    let out = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        out += s;
      },
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      SAVED_PANEL_NAME,
      "What does the data say?",
      "--expert",
      "analyst",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const events = parseNdjson(out);
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.expertSlug).toBe("analyst");
  });

  it("rejects an unknown --expert slug and lists the valid ones", async () => {
    await writeSavedPanel();
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        SAVED_PANEL_NAME,
        "What?",
        "--expert",
        "ghost",
        "--engine",
        "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no expert|not found/);
    expect(thrown).toMatch(/strategist/);
    expect(thrown).toMatch(/analyst/);
  });

  it("engages docs RAG — the engine prompt contains a [REFERENCE DOCUMENTS] block with the planted fact", async () => {
    await writeSavedPanel();
    await writePanelDoc(
      "facts.md",
      "The Zephyr retention window stores XYZZY4200 archived records.",
    );

    const recording = makeRecordingEngine();
    const cmd = buildAskCommand({
      engineFactory: recording.factory,
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      SAVED_PANEL_NAME,
      "Summarize the Zephyr retention window",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const prompts = recording.engine().sentPrompts;
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const prompt = prompts[0]?.prompt ?? "";
    expect(prompt).toContain("[REFERENCE DOCUMENTS]");
    expect(prompt).toContain("XYZZY4200");
  });

  it("answers a saved panel that has no documents (no reference block, no crash)", async () => {
    await writeSavedPanel();

    const recording = makeRecordingEngine();
    let out = "";
    const cmd = buildAskCommand({
      engineFactory: recording.factory,
      write: (s) => {
        out += s;
      },
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      SAVED_PANEL_NAME,
      "What is our strategy?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const events = parseNdjson(out);
    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(1);
    const prompt = recording.engine().sentPrompts[0]?.prompt ?? "";
    expect(prompt).not.toContain("[REFERENCE DOCUMENTS]");
  });

  it("regression: an active debate-session handle is still answered via the active-session path (unchanged)", async () => {
    // Seed a real active-session panel with experts directly in the DB.
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelId: string;
    try {
      const panel = await new PanelRepository(db).create({
        name: "live-session-panel",
        topic: "General",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      panelId = panel.id;
      await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "[1] IDENTITY\nYou are a CTO.",
      });
    } finally {
      await db.destroy();
    }

    let out = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        out += s;
      },
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-ask",
      "live-session-panel",
      "What should we ship?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const events = parseNdjson(out);
    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(1);

    // The active-session path reuses the existing panel — it does NOT create
    // a second ephemeral panel row.
    const verifyDb = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(verifyDb).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      const panels = await new PanelRepository(verifyDb).findAll();
      expect(panels.filter((p) => p.name === "live-session-panel")).toHaveLength(1);
      // T-PR16 .1: Assert total panel count to catch ephemeral-row pollution
      expect(panels).toHaveLength(1);
    } finally {
      await verifyDb.destroy();
    }
  });

  it("sanitizes expert slugs in 'No expert found' error (terminal injection defense)", async () => {
    // T-PRS2: Regression test for #2428 — expert slugs containing ANSI
    // escape sequences, control characters, or newlines in the "No expert
    // found" error were emitted unsanitized, enabling terminal injection
    // when processing untrusted saved panels. The fix applies
    // toSingleLineDisplay() to each slug before writing to stderr.
    //
    // Use JSON.stringify to properly escape the malicious content in YAML.
    const ansiSlug = "normal\x1B[31mREDTEXT\x1B[0m"; // ANSI red color
    const newlineSlug = "newline\ninjection"; // newline injection
    const maliciousYaml = [
      `name: ${SAVED_PANEL_NAME}`,
      "description: Panel with malicious slugs",
      "experts:",
      `  - slug: ${JSON.stringify(ansiSlug)}`,
      "    displayName: Normal Expert",
      "    role: Testing expert",
      "    expertise:",
      "      weightedEvidence:",
      "        - Test expertise",
      "      referenceCases: []",
      "      notExpertIn: []",
      "    epistemicStance: Test stance",
      `  - slug: ${JSON.stringify(newlineSlug)}`,
      "    displayName: Newline Expert",
      "    role: Testing expert",
      "    expertise:",
      "      weightedEvidence:",
      "        - Test expertise",
      "      referenceCases: []",
      "      notExpertIn: []",
      "    epistemicStance: Test stance",
    ].join("\n");

    await fs.writeFile(
      path.join(dataHome, "panels", `${SAVED_PANEL_NAME}.yaml`),
      maliciousYaml,
      "utf-8",
    );

    let capturedError = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s) => {
        capturedError += s;
      },
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        SAVED_PANEL_NAME,
        "test question",
        "--expert",
        "nonexistent",
        "--engine",
        "mock",
        "--format",
        "json",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }

    // The error message should mention the nonexistent expert.
    expect(thrown.toLowerCase()).toMatch(/no expert.*nonexistent/);

    // CRITICAL: The captured stderr must NOT contain raw ANSI sequences
    // or newlines from the slugs — toSingleLineDisplay() should have
    // stripped the ESC sequence and collapsed the newline to a space.
    expect(capturedError).not.toContain("\x1B[31m"); // no raw ANSI red
    expect(capturedError).not.toContain("\x1B[0m"); // no raw ANSI reset
    // The newline slug should be collapsed - look for the pattern in the Available list
    expect(capturedError).not.toMatch(/Available:.*newline\ninjection/); // no raw newline in slug list

    // The sanitized slugs should appear in the error as single-line text.
    // The ANSI sequences and newlines should be removed/collapsed.
    expect(capturedError).toContain("Available:");
    expect(capturedError).toMatch(/normal.*REDTEXT/); // ANSI stripped but text remains
    expect(capturedError).toMatch(/newline injection/); // newline collapsed to space
  });

  it("cleans up the ephemeral one-shot panel row even when the answer path throws (T-2473 · finally)", async () => {
    // T-2473 (🟡 · security): the ephemeral runtime panel row is created BEFORE
    // runOneExpertAsk runs. Previously the cleanup delete ran only on the
    // success path, so an engine/network/DB failure (or Ctrl-C) left the
    // `panels` row and its cascade children orphaned — accumulating across
    // repeated failures. The fix wraps the answer call in
    // `try { … } finally { …delete().catch(() => {}) }` so cleanup always runs
    // while the original error still propagates.
    await writeSavedPanel();

    // Force runOneExpertAsk to throw by injecting an engine factory that fails
    // during engine construction (a realistic engine-init failure). The panel
    // row exists by this point, so the pre-fix success-only delete is skipped.
    const boomFactory = (): CouncilEngine => {
      throw new Error("INJECTED_ONESHOT_BOOM: engine init failed");
    };
    const cmd = buildAskCommand({
      engineFactory: boomFactory,
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync([
        "node",
        "council-ask",
        SAVED_PANEL_NAME,
        "What is our long-term strategy?",
        "--engine",
        "mock",
        "--format",
        "json",
      ]);
    } catch (err) {
      thrown = err;
    }

    // (b) The original error must still propagate — the finally block must NOT
    // swallow it.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("INJECTED_ONESHOT_BOOM");

    // (a) No orphan: the ephemeral one-shot panel row must have been deleted on
    // the error path.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it.each(RAG_PAYLOADS)(
    "sanitizes control chars in the RAG scan/retrieval warning before writing to stderr ($label)",
    async ({ message, remnant }) => {
      // T-2473 (🟢 · security): the best-effort RAG failure warning interpolates
      // an untrusted ${msg} (a document path / parser error) straight to stderr.
      // A crafted path or error could smuggle ANSI/OSC/C0/C1/CR sequences into
      // the terminal. The fix routes msg through toSingleLineDisplay().
      await writeSavedPanel();

      // Make the RAG scan reject with a malicious message. The failure is
      // best-effort, so the ask still completes (exit 0) — we only inspect the
      // warning written to stderr.
      vi.mocked(scanPanelDocuments).mockRejectedValueOnce(new Error(message));

      let capturedError = "";
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          capturedError += s;
        },
      });
      cmd.exitOverride();

      await cmd.parseAsync([
        "node",
        "council-ask",
        SAVED_PANEL_NAME,
        "What is our long-term strategy?",
        "--engine",
        "mock",
        "--format",
        "json",
      ]);

      // The warning must have been emitted...
      expect(capturedError).toContain("Reference-document scan/retrieval failed");
      // ...with the printable remnant preserved (positive oracle: the sanitizer
      // must not empty or over-strip the message).
      expect(capturedError).toContain(remnant);

      // CRITICAL: the warning line must be free of raw control/ANSI/OSC/CR/C1
      // sequences. toSingleLineDisplay collapses the message onto one physical
      // line, so isolate that line and assert it is control-char-free.
      const warningLine =
        capturedError
          .split("\n")
          .find((l) => l.includes("Reference-document scan/retrieval failed")) ?? "";
      expect(warningLine).not.toMatch(CONTROL_RE);
    },
  );
});

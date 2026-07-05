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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAskCommand } from "../../../../src/cli/commands/ask.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

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

describe("buildAskCommand — saved-panel headless fallback (F-11)", () => {
  let testHome: string;
  let dataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
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
});

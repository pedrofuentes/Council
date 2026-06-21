import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConcludeCommand } from "../../src/cli/commands/conclude.js";
import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import { buildExportCommand } from "../../src/cli/commands/export.js";
import { buildResumeCommand } from "../../src/cli/commands/resume.js";
import { buildSessionsCommand } from "../../src/cli/commands/sessions.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import { DebateRepository, type Debate } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository, type Panel } from "../../src/memory/repositories/panels.js";
import { TurnRepository, type Turn } from "../../src/memory/repositories/turns.js";
import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  makeMockEngineFactory,
  openTestDb,
  seedCompletedDebate,
  type E2EContext,
} from "./helpers.js";

const TOPIC = "Should we ship the MVP?";
const SYNTHESIZER_ID = "e2e-synthesizer";
const SAMPLE_SYNTHESIS = {
  consensus: ["Both experts want a staged rollout"],
  tensions: ["Security wants stricter controls before launch"],
  decisionMatrix: [
    {
      dimension: "Launch plan",
      positions: [
        { expert: "CTO", stance: "Ship behind a feature flag" },
        { expert: "PM", stance: "Limit exposure to early adopters" },
      ],
    },
  ],
  recommendation: "Launch behind a feature flag with explicit security checks.",
  confidence: "medium",
} as const;

interface PersistedDebateState {
  readonly panel: Panel;
  readonly debates: readonly Debate[];
  readonly turns: readonly Turn[];
  readonly expertCount: number;
}

type CapturedOutput = ReturnType<typeof captureOutput>;

function parseJsonLines<T>(output: string): T[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as T);
}

async function loadPersistedState(ctx: E2EContext): Promise<PersistedDebateState> {
  const db = await openTestDb(ctx.testHome);
  try {
    const panels = await new PanelRepository(db).findAll();
    const panel = panels.at(-1);
    if (!panel) {
      throw new Error("Expected a persisted panel.");
    }

    const debates = await new DebateRepository(db).findByPanelId(panel.id);
    const latestDebate = debates.at(-1);
    if (!latestDebate) {
      throw new Error("Expected a persisted debate.");
    }

    const experts = await new ExpertRepository(db).findByPanelId(panel.id);
    const turns = await new TurnRepository(db).findByDebateId(latestDebate.id);

    return {
      panel,
      debates,
      turns,
      expertCount: experts.length,
    };
  } finally {
    await destroyTestDb(db);
  }
}

async function runConvene(
  args: readonly string[],
  engineFactory: () => CouncilEngine = makeMockEngineFactory(),
): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildConveneCommand({
    engineFactory,
    write: output.write,
    writeError: output.writeError,
  });
  await cmd.parseAsync(["node", "council-convene", ...args]);
  return output;
}

async function runResume(
  args: readonly string[],
  engineFactory: () => CouncilEngine = makeMockEngineFactory(),
): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildResumeCommand({
    engineFactory,
    write: output.write,
    writeError: output.writeError,
  });
  await cmd.parseAsync(["node", "council-resume", ...args]);
  return output;
}

async function runExport(args: readonly string[]): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildExportCommand({ write: output.write, writeError: output.writeError });
  await cmd.parseAsync(["node", "council-export", ...args]);
  return output;
}

async function runConclude(
  args: readonly string[],
  engineFactory: () => CouncilEngine = makeMockEngineFactory({
    responses: {
      [SYNTHESIZER_ID]: JSON.stringify(SAMPLE_SYNTHESIS),
    },
  }),
): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildConcludeCommand({
    engineFactory,
    synthesizerId: SYNTHESIZER_ID,
    write: output.write,
    writeError: output.writeError,
  });
  await cmd.parseAsync(["node", "council-conclude", ...args]);
  return output;
}

async function runSessions(args: readonly string[] = []): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildSessionsCommand(output.write);
  await cmd.parseAsync(["node", "council-sessions", ...args]);
  return output;
}

describe("debate lifecycle e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  it("convene with built-in template produces debate in DB", async () => {
    const output = await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const events = parseJsonLines<{ kind: string }>(output.stdout());
    const state = await loadPersistedState(ctx);

    expect(state.panel.topic).toBe(TOPIC);
    expect(state.expertCount).toBeGreaterThanOrEqual(2);
    expect(state.debates).toHaveLength(1);
    expect(state.debates[0]?.status).toBe("completed");
    expect(state.turns).toHaveLength(state.expertCount);
    expect(events[0]?.kind).toBe("panel.assembled");
    expect(events.some((event) => event.kind === "debate.end")).toBe(true);
    expect(events.at(-1)?.kind).toBe("conclusion");
  });

  it("convene with plain format produces readable output", async () => {
    const output = await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "plain",
      "--engine",
      "mock",
    ]);

    expect(output.stdout()).toContain("Topic: Should we ship the MVP?");
    expect(output.stdout()).not.toMatch(/^\s*\{/m);
  });

  it("convene with auto-compose and --yes", async () => {
    const output = captureOutput();
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: output.write,
      writeError: output.writeError,
    });

    // After the fix in T-05, mock engine with auto-compose now succeeds by
    // returning a deterministic fallback panel instead of failing on JSON parse.
    await cmd.parseAsync(["node", "council-convene", TOPIC, "--engine", "mock", "--yes"]);

    const db = await openTestDb(ctx.testHome);
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      // Panel name gets an ISO timestamp suffix appended during creation
      expect(panels[0]?.name).toMatch(/^mock-panel-/);
    } finally {
      await destroyTestDb(db);
    }
  });

  it("convene with --strategy devils-advocate", async () => {
    await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
      "--strategy",
      "devils-advocate",
    ]);

    const state = await loadPersistedState(ctx);
    expect(state.debates[0]?.moderator).toBe("devils-advocate");
    expect(state.debates[0]?.status).toBe("completed");
  });

  it("convene with --strategy consensus-check", async () => {
    await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
      "--strategy",
      "consensus-check",
    ]);

    const state = await loadPersistedState(ctx);
    expect(state.debates[0]?.moderator).toBe("consensus-check");
    expect(state.debates[0]?.status).toBe("completed");
  });

  it("convene structured mode (incident-postmortem)", async () => {
    const output = await runConvene([
      "Investigate the payment API outage.",
      "--template",
      "incident-postmortem",
      "--mode",
      "structured",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const events = parseJsonLines<{ kind: string }>(output.stdout());
    const state = await loadPersistedState(ctx);

    expect(state.panel.topic).toBe("Investigate the payment API outage.");
    expect(state.debates[0]?.moderator).toBe("structured-phases");
    expect(state.debates[0]?.status).toBe("completed");
    expect(state.turns.length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "debate.end")).toBe(true);
    expect(events.at(-1)?.kind).toBe("conclusion");
  });

  it("resume transcript mode replays debate", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const output = await runResume([seed.panelName, "--format", "plain"]);

    expect(output.stdout()).toContain(seed.panelName);
    expect(output.stdout()).toContain("CTO perspective: prefer a modular monolith first.");
    expect(output.stdout()).toContain("PM perspective: optimize for speed and learning.");
  });

  it("resume transcript JSON format", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const events = parseJsonLines<{ kind: string }>(
      (await runResume([seed.panelName, "--format", "json"])).stdout(),
    );

    expect(events[0]?.kind).toBe("panel.assembled");
    expect(events.filter((event) => event.kind === "turn.end")).toHaveLength(2);
    expect(events.at(-1)?.kind).toBe("debate.end");
  });

  it("resume continue mode runs new debate", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    await runResume([
      seed.panelName,
      "--prompt",
      "What about security?",
      "--engine",
      "mock",
      "--format",
      "json",
      "--max-rounds",
      "1",
    ]);

    const db = await openTestDb(ctx.testHome);
    try {
      const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
      expect(debates).toHaveLength(2);
      expect(debates.at(-1)?.prompt).toBe("What about security?");
      expect(debates.at(-1)?.status).toBe("completed");
    } finally {
      await destroyTestDb(db);
    }
  });

  it("export markdown format", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const output = await runExport([seed.panelName, "--format", "markdown"]);

    expect(output.stdout()).toContain(`# ${seed.panelName}`);
    expect(output.stdout()).toContain("## Transcript");
    expect(output.stdout()).toContain("CTO perspective: prefer a modular monolith first.");
  });

  it("export JSON format", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const events = parseJsonLines<{ kind: string }>(
      (await runExport([seed.panelName, "--format", "json"])).stdout(),
    );

    expect(events[0]?.kind).toBe("panel.assembled");
    expect(events.filter((event) => event.kind === "turn.end")).toHaveLength(2);
    expect(events.at(-1)?.kind).toBe("debate.end");
  });

  it("export ADR format", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const output = await runExport([seed.panelName, "--format", "adr"]);

    expect(output.stdout()).toContain("## Status");
    expect(output.stdout()).toContain("## Context");
    expect(output.stdout()).toContain("## Options Considered");
    expect(output.stdout()).toContain("## Discussion");
    expect(output.stdout()).toContain("## Decision");
  });

  it("export to file (--output)", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const outputPath = path.join(ctx.testHome, "debate-export.md");

    await runExport([seed.panelName, "--format", "markdown", "--output", outputPath]);

    const fileContents = await fs.readFile(outputPath, "utf8");
    expect(fileContents).toContain(seed.panelName);
    expect(fileContents).toContain("CTO perspective: prefer a modular monolith first.");
  });

  it("conclude produces decision matrix", async () => {
    const seed = await seedCompletedDebate(ctx.testHome);
    const output = await runConclude([seed.panelName, "--engine", "mock", "--format", "json"]);
    const parsed = JSON.parse(output.stdout()) as {
      readonly panelName: string;
      readonly decisionMatrix: readonly { readonly dimension: string }[];
      readonly recommendation: string;
    };

    expect(parsed.panelName).toBe(seed.panelName);
    expect(parsed.decisionMatrix).toHaveLength(1);
    expect(parsed.decisionMatrix[0]?.dimension).toBe("Launch plan");
    expect(parsed.recommendation).toContain("feature flag");
  });

  it("sessions list after convene", async () => {
    await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);
    const state = await loadPersistedState(ctx);
    const output = await runSessions(["--format", "plain"]);

    expect(output.stdout()).toContain(state.panel.name);
    expect(output.stdout()).toContain(TOPIC);
  });

  it("sessions list JSON format", async () => {
    await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const sessions = parseJsonLines<{ readonly name: string; readonly topic: string | null }>(
      (await runSessions(["--format", "json"])).stdout(),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.name).toContain("code-review-");
    expect(sessions[0]?.topic).toBe(TOPIC);
  });

  it("full lifecycle: convene → sessions → resume → export", async () => {
    await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);
    const state = await loadPersistedState(ctx);
    const firstTurnContent = state.turns[0]?.content ?? "";

    const sessionsOutput = await runSessions(["--format", "plain"]);
    const resumeOutput = await runResume([state.panel.name, "--format", "plain"]);
    const exportOutput = await runExport([state.panel.name, "--format", "markdown"]);

    expect(sessionsOutput.stdout()).toContain(state.panel.name);
    expect(resumeOutput.stdout()).toContain(state.panel.name);
    expect(resumeOutput.stdout()).toContain(firstTurnContent);
    expect(exportOutput.stdout()).toContain(`# ${state.panel.name}`);
    expect(exportOutput.stdout()).toContain(firstTurnContent);
  });

  it("export includes turns from BOTH the original debate and the resume follow-up", async () => {
    // Convene a panel (creates debate #1 with the initial prompt).
    await runConvene([
      TOPIC,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const stateAfterConvene = await loadPersistedState(ctx);
    const panelName = stateAfterConvene.panel.name;
    const originalTurnContents = stateAfterConvene.turns.map((t) => t.content);
    expect(originalTurnContents.length).toBeGreaterThan(0);

    // Resume with --prompt to add debate #2 (the follow-up).
    const followUpPrompt = "What about the security implications?";
    await runResume([
      panelName,
      "--prompt",
      followUpPrompt,
      "--engine",
      "mock",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--heuristic-memory",
    ]);

    // Sanity: the panel now has two debates persisted on the same panel_id.
    const db = await openTestDb(ctx.testHome);
    let followUpTurnContents: string[];
    try {
      const debates = await new DebateRepository(db).findByPanelId(stateAfterConvene.panel.id);
      expect(debates).toHaveLength(2);
      const followUpDebate = debates.at(-1);
      if (!followUpDebate) throw new Error("expected a follow-up debate");
      followUpTurnContents = (await new TurnRepository(db).findByDebateId(followUpDebate.id)).map(
        (t) => t.content,
      );
      expect(followUpTurnContents.length).toBeGreaterThan(0);
    } finally {
      await destroyTestDb(db);
    }

    // --- markdown export must contain content from BOTH debates ---
    const mdOutput = await runExport([panelName, "--format", "markdown"]);
    for (const content of originalTurnContents) {
      expect(mdOutput.stdout()).toContain(content);
    }
    for (const content of followUpTurnContents) {
      expect(mdOutput.stdout()).toContain(content);
    }

    // Round numbering should be sequential — no duplicate `### Round N` headers.
    const roundHeaders = mdOutput.stdout().match(/^### Round \d+$/gm) ?? [];
    const uniqueRoundHeaders = new Set(roundHeaders);
    expect(roundHeaders.length).toBe(uniqueRoundHeaders.size);
    expect(roundHeaders.length).toBeGreaterThanOrEqual(2);

    // --- json export must include turn.end events from BOTH debates ---
    const jsonOutput = await runExport([panelName, "--format", "json"]);
    const events = parseJsonLines<{ kind: string; content?: string }>(jsonOutput.stdout());
    const turnEndContents = events
      .filter((e) => e.kind === "turn.end")
      .map((e) => e.content ?? "");
    for (const content of originalTurnContents) {
      expect(turnEndContents).toContain(content);
    }
    for (const content of followUpTurnContents) {
      expect(turnEndContents).toContain(content);
    }

    // --- adr export must include content from BOTH debates in the Discussion ---
    const adrOutput = await runExport([panelName, "--format", "adr"]);
    for (const content of originalTurnContents) {
      expect(adrOutput.stdout()).toContain(content);
    }
    for (const content of followUpTurnContents) {
      expect(adrOutput.stdout()).toContain(content);
    }
  });
});

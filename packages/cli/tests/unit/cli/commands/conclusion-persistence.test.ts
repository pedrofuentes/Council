/**
 * Integration tests for persisting the auto-generated Decision Framework
 * conclusion and surfacing it in exports (T-15b / F-02).
 *
 * Acceptance:
 *   - `council conclude` persists the synthesized conclusion into the
 *     panel's config_json (no migration), overwriting on re-run.
 *   - `council convene` (auto-conclude) persists it too.
 *   - `council export <panel>` markdown gains a Decision Framework section.
 *   - `council export <panel> --format share` shows the real recommendation
 *     instead of the "does not persist a synthesized recommendation" apology.
 *   - `--no-conclude` persists nothing and export degrades gracefully; legacy
 *     panels with no stored conclusion still export without a framework.
 *
 * RED at this commit: nothing persists the conclusion, so export omits it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConcludeCommand } from "../../../../src/cli/commands/conclude.js";
import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { buildExportCommand } from "../../../../src/cli/commands/export.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import {
  readStoredConclusions,
  selectStoredConclusion,
} from "../../../../src/cli/conclusion-store.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

const SYNTH_ID = "synthesizer-fixed-id-for-tests";

const REC_1 = "Adopt the strangler-fig migration starting with billing.";
const REC_2 = "Freeze migration for one quarter and hire two SREs first.";

function synthJson(recommendation: string): string {
  return JSON.stringify({
    consensus: ["The monolith coupling is painful for everyone"],
    tensions: ["Migration timeline is disputed"],
    decisionMatrix: [
      { dimension: "Blast radius", positions: [{ expert: "CTO", stance: "Contained" }] },
    ],
    recommendation,
    confidence: "medium",
  });
}

async function seedPanelWithDebate(
  testHome: string,
  name = "persist-export-test",
): Promise<string> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name,
      topic: "Should we migrate to microservices?",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Should we migrate to microservices?",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO: the monolith's coupling is a real problem; we should split.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM: I agree on the pain, but timing matters; we lack ops headcount.",
    });
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return panel.name;
  } finally {
    await db.destroy();
  }
}

async function runConclude(panelName: string, recommendation: string): Promise<void> {
  const cmd = buildConcludeCommand({
    write: () => undefined,
    writeError: () => undefined,
    writeNotice: () => undefined,
    engineFactory: () => new MockEngine({ responses: { [SYNTH_ID]: synthJson(recommendation) } }),
    synthesizerId: SYNTH_ID,
  });
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);
}

async function runExport(panelName: string, format: string): Promise<string> {
  let captured = "";
  const cmd = buildExportCommand({
    write: (s) => {
      captured += s;
    },
    writeError: () => undefined,
  });
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-export", panelName, "--format", format]);
  return captured;
}

async function latestPanelName(testHome: string): Promise<string> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).findMostRecentlyActive();
    if (!panel) throw new Error("no panel found");
    return panel.name;
  } finally {
    await db.destroy();
  }
}

async function configJsonFor(testHome: string, panelName: string): Promise<string> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).findByName(panelName);
    if (!panel) throw new Error("no panel found");
    return panel.configJson;
  } finally {
    await db.destroy();
  }
}

describe("conclusion persistence + export surfacing", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-persist-export-test-"));
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

  it("conclude persists the framework; markdown export surfaces it before the transcript", async () => {
    const panelName = await seedPanelWithDebate(testHome);
    await runConclude(panelName, REC_1);

    // Persisted into config_json (no migration).
    const stored = selectStoredConclusion(await configJsonFor(testHome, panelName));
    expect(stored?.output.recommendation).toBe(REC_1);

    const md = await runExport(panelName, "markdown");
    expect(md).toContain("## Decision Framework");
    expect(md).toContain(REC_1);
    expect(md).toContain("The monolith coupling is painful for everyone");
    expect(md).toContain("Migration timeline is disputed");
    expect(md).toContain("Blast radius");
    // Framework section precedes the transcript.
    expect(md.indexOf("## Decision Framework")).toBeLessThan(md.indexOf("## Transcript"));
  });

  it("share export shows the real recommendation, not the apology placeholder", async () => {
    const panelName = await seedPanelWithDebate(testHome);
    await runConclude(panelName, REC_1);

    const share = await runExport(panelName, "share");
    expect(share).toContain(REC_1);
    expect(share).not.toContain("does not persist a synthesized recommendation");
  });

  it("re-running conclude overwrites the stored conclusion", async () => {
    const panelName = await seedPanelWithDebate(testHome);
    await runConclude(panelName, REC_1);
    await runConclude(panelName, REC_2);

    const all = readStoredConclusions(await configJsonFor(testHome, panelName));
    expect(all).toHaveLength(1);
    expect(all[0]?.output.recommendation).toBe(REC_2);

    const md = await runExport(panelName, "markdown");
    expect(md).toContain(REC_2);
    expect(md).not.toContain(REC_1);
  });

  it("legacy panel with no stored conclusion exports gracefully", async () => {
    const panelName = await seedPanelWithDebate(testHome, "legacy-no-conclusion");
    // Never conclude.
    const md = await runExport(panelName, "markdown");
    expect(md).not.toContain("## Decision Framework");
    expect(md).toContain("## Transcript"); // still a valid export

    const share = await runExport(panelName, "share");
    // Graceful: the honest apology note remains for panels lacking a conclusion.
    expect(share).toContain("does not persist a synthesized recommendation");
  });

  it("convene auto-conclude persists the framework and export surfaces it", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new MockEngine(),
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--heuristic-memory",
    ]);

    const panelName = await latestPanelName(testHome);
    const stored = selectStoredConclusion(await configJsonFor(testHome, panelName));
    expect(stored).toBeDefined();

    const md = await runExport(panelName, "markdown");
    expect(md).toContain("## Decision Framework");
    // Default MockEngine synthesizer recommendation.
    expect(md).toContain("Proceed with a phased approach");
    expect(md).toContain("Risk vs Innovation");
  });

  it("convene --no-conclude persists nothing and export shows no framework", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new MockEngine(),
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--heuristic-memory",
      "--no-conclude",
    ]);

    const panelName = await latestPanelName(testHome);
    expect(readStoredConclusions(await configJsonFor(testHome, panelName))).toEqual([]);

    const md = await runExport(panelName, "markdown");
    expect(md).not.toContain("## Decision Framework");
  });
});

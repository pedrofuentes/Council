/**
 * Tests for conclude using configurable transcript character cap from config.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConcludeCommand,
  buildSynthesisPrompt,
  type ConcludeOutput,
} from "../../../../src/cli/commands/conclude.js";
import type { TranscriptDocument } from "../../../../src/memory/transcript.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { updateConfigField } from "../../../../src/config/index.js";

const SYNTH_ID = "synthesizer-fixed-id-for-tests";

const SAMPLE_OUTPUT: Omit<ConcludeOutput, "panelName" | "topic"> = {
  consensus: ["Both experts agree on something"],
  tensions: ["Minor tension about timing"],
  decisionMatrix: [
    {
      dimension: "Risk",
      positions: [
        { expert: "Expert1", stance: "High" },
        { expert: "Expert2", stance: "Low" },
      ],
    },
  ],
  recommendation: "Proceed with caution",
  confidence: "medium",
  debateId: "debate-id",
  startedAt: "2024-01-01T00:00:00.000Z",
};

async function seedPanelWithLongTranscript(
  testHome: string,
  turnCount: number,
  turnLength: number,
): Promise<string> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "long-transcript-panel",
      topic: "Long transcript test",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const expert1 = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "expert1",
      displayName: "Expert1",
      model: "claude-sonnet-4",
      systemMessage: "You are an expert.",
    });
    const expert2 = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "expert2",
      displayName: "Expert2",
      model: "claude-sonnet-4",
      systemMessage: "You are also an expert.",
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Long transcript test",
      moderator: "round-robin",
    });

    // Create turns with long content to exceed the cap
    const longContent = "x".repeat(turnLength);
    for (let i = 0; i < turnCount; i++) {
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: Math.floor(i / 2),
        seq: i,
        speakerKind: "expert",
        expertId: i % 2 === 0 ? expert1.id : expert2.id,
        content: `Turn ${i}: ${longContent}`,
      });
    }

    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return panel.name;
  } finally {
    await db.destroy();
  }
}

function makeMockEngine(jsonResponse: string): MockEngine {
  return new MockEngine({
    responses: { [SYNTH_ID]: jsonResponse },
  });
}

describe("conclude with configurable transcript cap", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-conclude-cap-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("uses default cap (50000) when config is not set", async () => {
    // Seed a panel with a long transcript
    const panelName = await seedPanelWithLongTranscript(testHome, 100, 1000);

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeNotice: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);

    // Should see truncation warning with 50000 char limit (default)
    expect(captured).toMatch(/50000 char limit/);
  });

  it("uses raised cap from config to allow more transcript content", async () => {
    // Set a higher cap
    await updateConfigField("conclude.maxTranscriptChars", 150000);

    const panelName = await seedPanelWithLongTranscript(testHome, 100, 1000);

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeNotice: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);

    // With a higher cap, the 100k transcript should not trigger the warning
    expect(captured).not.toMatch(/50000 char limit/);
  });

  it("uses lowered cap from config to truncate more aggressively", async () => {
    // Set a lower cap
    await updateConfigField("conclude.maxTranscriptChars", 10000);

    const panelName = await seedPanelWithLongTranscript(testHome, 50, 500);

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeNotice: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);

    // Should see truncation warning with 10000 char limit (configured)
    expect(captured).toMatch(/10000 char limit/);
  });

  it("buildSynthesisPrompt uses the default cap (50000) when not configured", () => {
    const doc: TranscriptDocument = {
      panel: { id: "p1", name: "test", topic: "Test topic", copilotHome: "/tmp" },
      latestDebate: { id: "d1", status: "completed", prompt: "Test", startedAt: "2024-01-01T00:00:00.000Z" },
      experts: [{ id: "e1", slug: "expert", displayName: "Expert", model: "claude-sonnet-4" }],
      turns: [
        { round: 0, seq: 0, speakerKind: "expert", expertId: "e1", content: "x".repeat(30000) },
        { round: 0, seq: 1, speakerKind: "expert", expertId: "e1", content: "y".repeat(30000) },
      ],
    };

    const result = buildSynthesisPrompt(doc);

    // With default 50000 cap, the 60k total content should be truncated
    expect(result.truncated).toBe(true);
    expect(result.truncatedByChars).toBe(true);
    expect(result.appliedCharLimit).toBe(50000);
  });
});

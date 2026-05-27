/**
 * Tests for `council conclude [panel] --model <model>` flag.
 *
 * RED at this commit: `--model` flag does not exist yet.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConcludeCommand,
  type ConcludeOutput,
} from "../../../../src/cli/commands/conclude.js";
import type { ExpertSpec } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

const SAMPLE_OUTPUT: Omit<ConcludeOutput, "panelName" | "topic"> = {
  consensus: ["Both experts agree the monolith has real coupling pain points"],
  tensions: ["CTO wants migration now, PM wants to wait for hiring"],
  decisionMatrix: [
    {
      dimension: "Risk",
      positions: [
        { expert: "CTO", stance: "High operational risk" },
        { expert: "PM", stance: "Medium velocity risk" },
      ],
    },
  ],
  recommendation: "Begin a phased migration starting with the auth subsystem.",
  confidence: "medium",
};

interface SeedResult {
  readonly panelName: string;
}

async function seedPanelWithDebate(testHome: string, name = "conclude-test"): Promise<SeedResult> {
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
      content: "PM: we lack the team size to operate multiple services effectively.",
    });
    await new DebateRepository(db).update(debate.id, { status: "completed" });

    return { panelName: name };
  } finally {
    await db.destroy();
  }
}

/** Test engine that tracks the model used for the synthesizer expert. */
class ModelTrackingEngine extends MockEngine {
  synthesizerModel: string | null = null;

  constructor(responses?: Record<string, string>) {
    super({ responses });
  }

  override async addExpert(spec: ExpertSpec): Promise<void> {
    await super.addExpert(spec);
    if (spec.slug === "synthesizer") {
      this.synthesizerModel = spec.model;
    }
  }
}

describe("buildConcludeCommand — --model flag", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "conclude-model-flag-"));
    originalHome = process.env.COUNCIL_HOME;
    process.env.COUNCIL_HOME = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));

    // Write minimal config
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `defaults:
  engine: mock
  model: default-model
`,
    );

    await seedPanelWithDebate(testHome);
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.COUNCIL_HOME = originalHome;
    } else {
      delete process.env.COUNCIL_HOME;
    }
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("passes --model value to synthesizer expert", async () => {
    const engine = new ModelTrackingEngine({
      synthesizer: JSON.stringify({ ...SAMPLE_OUTPUT, panelName: "conclude-test", topic: "test topic" }),
    });

    const cmd = buildConcludeCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      synthesizerId: "synthesizer",
    });

    await cmd.parseAsync(["node", "council-conclude", "conclude-test", "--model", "gpt-5.2", "--format", "json"]);

    // Verify that the model was used for the synthesizer expert
    expect(engine.synthesizerModel).toBe("gpt-5.2");
  });

  it("uses config default model when --model is not provided", async () => {
    const engine = new ModelTrackingEngine({
      synthesizer: JSON.stringify({ ...SAMPLE_OUTPUT, panelName: "conclude-test", topic: "test topic" }),
    });

    const cmd = buildConcludeCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      synthesizerId: "synthesizer",
    });

    await cmd.parseAsync(["node", "council-conclude", "conclude-test", "--format", "json"]);

    // Verify that the default model from config was used
    expect(engine.synthesizerModel).toBe("default-model");
  });
});

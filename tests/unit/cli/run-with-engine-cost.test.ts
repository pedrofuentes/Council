/**
 * Cost visibility tests for runWithEngine.
 *
 * RED at this commit: mock-engine debates still stream the human-facing
 * cost counter, even though the values are synthetic and confusing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithEngine, type EngineKind } from "../../../src/cli/run-with-engine.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";

const expert: ExpertSpec = {
  id: "placeholder",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

describe("runWithEngine cost visibility", () => {
  let db: CouncilDatabase;
  let panelId: string;
  let expertSlugToId: Record<string, string>;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    const panel = await new PanelRepository(db).create({
      name: "cost-visibility-panel",
      topic: "General",
      copilotHome: "memory://copilot",
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    panelId = panel.id;
    const savedExpert = await new ExpertRepository(db).create({
      panelId,
      slug: expert.slug,
      displayName: expert.displayName,
      model: expert.model,
      systemMessage: expert.systemMessage,
    });
    expertSlugToId = { [expert.slug]: savedExpert.id };
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function renderDebate(engineKind: EngineKind): Promise<string> {
    let stdout = "";

    await runWithEngine({
      engineKind,
      engineFactory: () => new MockEngine(),
      experts: [{ ...expert, id: expertSlugToId[expert.slug] ?? "" }],
      debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
      prompt: "What should we do?",
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      format: "plain",
      write: (text) => {
        stdout += text;
      },
      writeError: (text) => {
        stdout += text;
      },
      isTTY: false,
      db,
    });

    return stdout;
  }

  it("suppresses the cost counter for the mock engine", async () => {
    const output = await renderDebate("mock");

    expect(output).not.toContain("[Cost:");
  });

  it("still shows the cost counter for non-mock engines", async () => {
    const output = await renderDebate("copilot");

    expect(output).toContain("[Cost: 1/1 premium requests]");
  });
});

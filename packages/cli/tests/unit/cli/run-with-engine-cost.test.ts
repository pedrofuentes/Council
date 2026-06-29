/**
 * Cost visibility tests for runWithEngine.
 *
 * Cost visibility is keyed off the engine's `supportsCostMetrics`
 * capability — NOT a hard-coded `engineKind !== "mock"` string compare
 * (#852). Both cases below construct via the same engineKind so the only
 * variable is the engine's declared capability.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithEngine, type EngineKind } from "../../../src/cli/run-with-engine.js";
import type { CouncilEngine, ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

/** Mock engine that reports billable cost metrics — the copilot capability. */
class CostCapableEngine extends MockEngine {
  readonly supportsCostMetrics = true;
}
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

  async function renderDebate(engineFactory: () => CouncilEngine): Promise<string> {
    let stdout = "";

    // engineKind is held constant; only the engine capability varies.
    const engineKind: EngineKind = "mock";

    await runWithEngine({
      engineKind,
      engineFactory,
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

  it("suppresses the cost counter when the engine lacks cost metrics", async () => {
    const output = await renderDebate(() => new MockEngine());

    expect(output).not.toContain("[Cost:");
    expect(output).not.toContain("[Premium requests:");
  });

  it("shows the cost counter when the engine supports cost metrics", async () => {
    const output = await renderDebate(() => new CostCapableEngine());

    expect(output).toContain("[Premium requests: 1 (est. ~1)]");
  });
});

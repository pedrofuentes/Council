/**
 * Behavioral contract for #241: `runWithEngine` decides whether to emit the
 * caller's `preamble` by consulting the chosen renderer's declarative
 * `supportsPreamble` flag — NOT an `instanceof PlainRenderer` check.
 *
 * The plain renderer supports preambles (a plain-text header is emitted); the
 * JSON renderer does not (a preamble would corrupt the NDJSON stream), so a
 * renderer with `supportsPreamble === false` suppresses the preamble.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { runWithEngine, type EngineKind } from "../../../src/cli/run-with-engine.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import type { RendererFormat } from "../../../src/cli/renderers/select.js";

const expert: ExpertSpec = {
  id: "placeholder",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

describe("runWithEngine preamble decision (#241)", () => {
  let db: CouncilDatabase;
  let panelId: string;
  let expertSlugToId: Record<string, string>;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    const panel = await new PanelRepository(db).create({
      name: "preamble-panel",
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

  async function runWithFormat(format: RendererFormat): Promise<Mock<() => void>> {
    const preamble: Mock<() => void> = vi.fn();
    await runWithEngine({
      engineKind: "mock" as EngineKind,
      engineFactory: () => new MockEngine(),
      experts: [{ ...expert, id: expertSlugToId[expert.slug] ?? "" }],
      debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
      prompt: "What should we do?",
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      format,
      preamble,
      write: () => {
        /* discard */
      },
      writeError: () => {
        /* discard */
      },
      isTTY: false,
      db,
    });
    return preamble;
  }

  it("emits the preamble for a preamble-supporting renderer (plain)", async () => {
    const preamble = await runWithFormat("plain");
    expect(preamble).toHaveBeenCalledTimes(1);
  });

  it("suppresses the preamble for a non-preamble renderer (json)", async () => {
    const preamble = await runWithFormat("json");
    expect(preamble).not.toHaveBeenCalled();
  });
});

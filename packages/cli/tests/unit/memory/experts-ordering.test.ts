/**
 * Insertion-order determinism for {@link ExpertRepository.findByPanelId}.
 *
 * `council ask <panel> "q"` with no `--expert` picks `allExperts[0]`, so the
 * order returned by `findByPanelId` must be stable and equal to insertion
 * order. Expert ids were generated with the non-monotonic `ulid()`, which —
 * for two experts created in the same millisecond — sorts by ULID randomness
 * instead of insertion order. That non-determinism is the root cause of CI
 * flake #1281 (CTO vs PM as the default expert).
 *
 * This suite creates several experts in a tight loop (same panel, same ms)
 * and asserts they come back in insertion order. Repeating the scenario many
 * times makes the pre-fix failure reliable rather than probabilistic.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository, type NewPanel } from "../../../src/memory/repositories/panels.js";
import { ExpertRepository, type NewExpert } from "../../../src/memory/repositories/experts.js";

const SAMPLE_PANEL: NewPanel = {
  name: "architecture-review",
  topic: "Should we migrate to microservices?",
  copilotHome: "/tmp/.council/panels/01HZ-arch/copilot",
  configJson: JSON.stringify({ experts: 4, mode: "freeform" }),
};

function sampleExpert(panelId: string, slug: string): NewExpert {
  return {
    panelId,
    slug,
    displayName: `Expert ${slug}`,
    model: "claude-sonnet-4",
    systemMessage: `You are ${slug}.`,
  };
}

describe("ExpertRepository.findByPanelId insertion-order determinism", () => {
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns experts in insertion order for same-millisecond inserts", async () => {
    const panels = new PanelRepository(db);
    const experts = new ExpertRepository(db);

    // Repeat to defeat the probabilistic nature of the bug: with the
    // non-monotonic ulid() at least one iteration reorders same-ms inserts.
    for (let iter = 0; iter < 20; iter++) {
      const panel = await panels.create({
        ...SAMPLE_PANEL,
        name: `panel-${iter}`,
      });

      const insertionSlugs = ["e0", "e1", "e2", "e3", "e4"];
      for (const slug of insertionSlugs) {
        await experts.create(sampleExpert(panel.id, slug));
      }

      const found = await experts.findByPanelId(panel.id);
      expect(found.map((e) => e.slug)).toEqual(insertionSlugs);
      // The default-expert contract: index 0 is the first-inserted expert.
      expect(found[0]?.slug).toBe("e0");
    }
  });
});

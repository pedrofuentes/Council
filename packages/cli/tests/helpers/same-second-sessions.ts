import * as path from "node:path";

import { createDatabase } from "../../src/memory/db.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";

/**
 * Seeds two sessions that share the same timestamped name (simulating creation
 * in the same second) but have distinct ULIDs (session ids) and distinguishable
 * debate content.
 *
 * **Deterministic ordering**: uses sequential `await` (no setTimeout) to ensure
 * the second session's `createdAt` is strictly after the first's, so export/
 * resume ordering by `id` is stable across test runs.
 *
 * Use case: tests that verify ULID-based resolution can distinguish sessions
 * that share a timestamped resume/export name (T-14/F-08).
 */
export async function seedTwoSameSecondSessions(testHome: string): Promise<{
  readonly sharedName: string;
  readonly first: { readonly id: string; readonly marker: string };
  readonly second: { readonly id: string; readonly marker: string };
}> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const sharedName = "same-second-2026-06-16T23:47:21";

    async function seedOne(marker: string): Promise<string> {
      const panel = await panelRepo.create({
        name: sharedName,
        topic: `Topic ${marker}`,
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const cto = await expertRepo.create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "You are a CTO.",
      });
      const debate = await debateRepo.create({
        panelId: panel.id,
        prompt: `Prompt ${marker}`,
        moderator: "round-robin",
      });
      await turnRepo.create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: marker,
      });
      await debateRepo.update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      return panel.id;
    }

    const firstMarker = "FIRST-SESSION-UNIQUE-CONTENT-alpha";
    const firstId = await seedOne(firstMarker);
    const secondMarker = "SECOND-SESSION-UNIQUE-CONTENT-beta";
    const secondId = await seedOne(secondMarker);

    return {
      sharedName,
      first: { id: firstId, marker: firstMarker },
      second: { id: secondId, marker: secondMarker },
    };
  } finally {
    await db.destroy();
  }
}

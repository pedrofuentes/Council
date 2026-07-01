/**
 * Tests for DebateRepository — typed CRUD over the `debates` table.
 *
 * RED at this commit: src/memory/repositories/debates.ts does not exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";

describe("DebateRepository", () => {
  let db: CouncilDatabase;
  let panelId: string;
  let repo: DebateRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    const panel = await new PanelRepository(db).create({
      name: "test-panel",
      copilotHome: "test-copilot-home",
      configJson: "{}",
    });
    panelId = panel.id;
    repo = new DebateRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() inserts a debate with status='running' and startedAt set", async () => {
    const debate = await repo.create({
      panelId,
      prompt: "Should we ship MVP?",
      moderator: "round-robin",
    });
    expect(debate.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(debate.panelId).toBe(panelId);
    expect(debate.prompt).toBe("Should we ship MVP?");
    expect(debate.status).toBe("running");
    expect(debate.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(debate.endedAt).toBeNull();
    expect(debate.costEstimate).toBeNull();
  });

  it("findById() returns the inserted debate", async () => {
    const created = await repo.create({
      panelId,
      prompt: "Topic",
      moderator: "round-robin",
    });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it("findById() returns undefined for unknown id", async () => {
    const found = await repo.findById("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(found).toBeUndefined();
  });

  it("findByPanelId() returns all debates for a panel ordered by startedAt", async () => {
    const a = await repo.create({ panelId, prompt: "A", moderator: "round-robin" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create({ panelId, prompt: "B", moderator: "round-robin" });
    const all = await repo.findByPanelId(panelId);
    expect(all.map((d) => d.id)).toEqual([a.id, b.id]);
  });

  it("update() can transition status and set endedAt + costEstimate", async () => {
    const created = await repo.create({
      panelId,
      prompt: "Topic",
      moderator: "round-robin",
    });
    const endedAt = new Date().toISOString();
    const updated = await repo.update(created.id, {
      status: "completed",
      endedAt,
      costEstimate: 0.42,
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.endedAt).toBe(endedAt);
    expect(updated?.costEstimate).toBe(0.42);
  });

  describe("countByPanelIds() — batched debate count (#1825)", () => {
    it("returns 0 for an empty id list without issuing an invalid `IN ()` query", async () => {
      // The empty-array short-circuit avoids a malformed `WHERE panel_id IN ()`
      // that some SQLite builds reject; it must resolve to 0, not throw.
      await expect(repo.countByPanelIds([])).resolves.toBe(0);
    });

    it("counts every debate across the supplied panel ids in a single call", async () => {
      const panelB = await new PanelRepository(db).create({
        name: "second-panel",
        copilotHome: "test-copilot-home",
        configJson: "{}",
      });
      await repo.create({ panelId, prompt: "a1", moderator: "round-robin" });
      await repo.create({ panelId, prompt: "a2", moderator: "round-robin" });
      await repo.create({ panelId: panelB.id, prompt: "b1", moderator: "round-robin" });

      // Sum across BOTH ids (2 + 1) — the whole class, not one panel.
      await expect(repo.countByPanelIds([panelId, panelB.id])).resolves.toBe(3);
    });

    it("excludes debates whose panel id is not in the supplied list", async () => {
      const panelB = await new PanelRepository(db).create({
        name: "second-panel",
        copilotHome: "test-copilot-home",
        configJson: "{}",
      });
      await repo.create({ panelId, prompt: "a1", moderator: "round-robin" });
      await repo.create({ panelId: panelB.id, prompt: "b1", moderator: "round-robin" });
      await repo.create({ panelId: panelB.id, prompt: "b2", moderator: "round-robin" });

      // Only panelId's single debate is counted; panelB's two are excluded.
      await expect(repo.countByPanelIds([panelId])).resolves.toBe(1);
    });

    it("matches the sum of per-panel findByPanelId lengths (parity with the old N+1 path)", async () => {
      const panelB = await new PanelRepository(db).create({
        name: "second-panel",
        copilotHome: "test-copilot-home",
        configJson: "{}",
      });
      await repo.create({ panelId, prompt: "a1", moderator: "round-robin" });
      await repo.create({ panelId, prompt: "a2", moderator: "round-robin" });
      await repo.create({ panelId: panelB.id, prompt: "b1", moderator: "round-robin" });

      const perPanel =
        (await repo.findByPanelId(panelId)).length + (await repo.findByPanelId(panelB.id)).length;
      await expect(repo.countByPanelIds([panelId, panelB.id])).resolves.toBe(perPanel);
    });
  });
});

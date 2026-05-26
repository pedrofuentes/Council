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
      copilotHome: "/tmp/copilot",
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
});

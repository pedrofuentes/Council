/**
 * Tests for ProfileRepository — Roadmap 6.2.
 *
 * RED at this commit: migration 007 and
 * src/memory/repositories/profile-repository.ts do not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertLibraryRepository } from "../../../src/memory/repositories/expert-library-repo.js";
import { ProfileRepository } from "../../../src/memory/repositories/profile-repository.js";
import type { PersonaProfile } from "../../../src/core/documents/profile-analyzer.js";

async function seedExpert(db: CouncilDatabase, slug = "ceo"): Promise<void> {
  const repo = new ExpertLibraryRepository(db);
  await repo.create({
    slug,
    kind: "persona",
    displayName: "Test Persona",
    yamlPath: `/tmp/Council/experts/${slug}.yaml`,
    yamlChecksum: "y1",
  });
}

function sampleProfile(overrides: Partial<PersonaProfile> = {}): PersonaProfile {
  return {
    communicationStyle: "Direct and pithy.",
    decisionPatterns: ["Ships fast", "Prefers data"],
    biases: ["Recency bias"],
    vocabulary: ["ship", "now", "data"],
    epistemicStance: "Empirical.",
    lastUpdated: "2026-05-12T00:00:00.000Z",
    documentCount: 3,
    totalWords: 1500,
    ...overrides,
  };
}

describe("ProfileRepository", () => {
  let db: CouncilDatabase;
  let repo: ProfileRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    await seedExpert(db);
    repo = new ProfileRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns null for a slug with no profile", async () => {
    const out = await repo.findBySlug("ceo");
    expect(out).toBeNull();
  });

  it("upsert + findBySlug round-trips the full profile", async () => {
    const profile = sampleProfile();
    await repo.upsert("ceo", profile);
    const found = await repo.findBySlug("ceo");
    expect(found).not.toBeNull();
    if (!found) throw new Error("expected profile");
    expect(found.communicationStyle).toBe(profile.communicationStyle);
    expect(found.decisionPatterns).toEqual(profile.decisionPatterns);
    expect(found.biases).toEqual(profile.biases);
    expect(found.vocabulary).toEqual(profile.vocabulary);
    expect(found.epistemicStance).toBe(profile.epistemicStance);
    expect(found.documentCount).toBe(profile.documentCount);
    expect(found.totalWords).toBe(profile.totalWords);
    expect(found.lastUpdated).toBe(profile.lastUpdated);
  });

  it("upsert overwrites an existing profile (same slug)", async () => {
    await repo.upsert("ceo", sampleProfile({ communicationStyle: "first" }));
    await repo.upsert("ceo", sampleProfile({ communicationStyle: "second" }));
    const found = await repo.findBySlug("ceo");
    if (!found) throw new Error("expected profile");
    expect(found.communicationStyle).toBe("second");
  });

  it("delete removes the profile", async () => {
    await repo.upsert("ceo", sampleProfile());
    await repo.delete("ceo");
    expect(await repo.findBySlug("ceo")).toBeNull();
  });

  it("delete of an unknown slug is a no-op", async () => {
    await expect(repo.delete("nobody")).resolves.toBeUndefined();
  });

  it("warns (does not silently coerce) when a stored JSON array column is corrupt (#362)", async () => {
    await repo.upsert("ceo", sampleProfile());

    await db
      .updateTable("persona_profiles")
      .set({ decision_patterns: "{not-json" })
      .where("expert_slug", "=", "ceo")
      .execute();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const found = await repo.findBySlug("ceo");
      expect(found).not.toBeNull();
      expect(found?.decisionPatterns).toEqual([]);
      expect(found?.communicationStyle).toBe(sampleProfile().communicationStyle);
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msg).toMatch(/decision_patterns/);
      expect(msg).toMatch(/ceo/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when stored JSON parses to a non-array value (#362)", async () => {
    await repo.upsert("ceo", sampleProfile());
    await db
      .updateTable("persona_profiles")
      .set({ biases: '"a string, not an array"' })
      .where("expert_slug", "=", "ceo")
      .execute();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const found = await repo.findBySlug("ceo");
      expect(found?.biases).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msg).toMatch(/biases/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("upsert is atomic — no SELECT-then-INSERT race (#363)", async () => {
    let preSelected = false;
    const dbAny = db as unknown as {
      selectFrom: (t: string) => unknown;
    };
    const origSelect = dbAny.selectFrom.bind(db);
    dbAny.selectFrom = (table: string) => {
      if (table === "persona_profiles") preSelected = true;
      return origSelect(table);
    };
    try {
      await repo.upsert("ceo", sampleProfile({ communicationStyle: "atomic-1" }));
      await repo.upsert("ceo", sampleProfile({ communicationStyle: "atomic-2" }));
    } finally {
      dbAny.selectFrom = origSelect;
    }
    expect(preSelected).toBe(false);
    const found = await repo.findBySlug("ceo");
    expect(found?.communicationStyle).toBe("atomic-2")
  });

  it("profiles are scoped per slug", async () => {
    await seedExpert(db, "cto");
    await repo.upsert("ceo", sampleProfile({ communicationStyle: "ceo style" }));
    await repo.upsert("cto", sampleProfile({ communicationStyle: "cto style" }));
    const ceo = await repo.findBySlug("ceo");
    const cto = await repo.findBySlug("cto");
    expect(ceo?.communicationStyle).toBe("ceo style");
    expect(cto?.communicationStyle).toBe("cto style");
  });
});

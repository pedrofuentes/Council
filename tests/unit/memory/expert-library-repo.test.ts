/**
 * Tests for ExpertLibraryRepository — typed CRUD over the expert_library
 * table introduced by migration 004.
 *
 * RED at this commit: src/memory/repositories/expert-library-repo.ts does
 * not yet exist.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  ExpertLibraryRepository,
  type NewLibraryExpert,
} from "../../../src/memory/repositories/expert-library-repo.js";

function sample(slug = "cto"): NewLibraryExpert {
  return {
    slug,
    kind: "generic",
    displayName: "Dahlia Renner (CTO)",
    yamlPath: `/tmp/Council/experts/${slug}.yaml`,
    yamlChecksum: "abc123",
  };
}

describe("ExpertLibraryRepository", () => {
  let db: CouncilDatabase;
  let repo: ExpertLibraryRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    repo = new ExpertLibraryRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() inserts a row and returns the domain object with timestamps", async () => {
    const created = await repo.create(sample("cto"));
    expect(created.slug).toBe("cto");
    expect(created.kind).toBe("generic");
    expect(created.displayName).toBe("Dahlia Renner (CTO)");
    expect(created.yamlPath).toContain("cto.yaml");
    expect(created.yamlChecksum).toBe("abc123");
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("findBySlug() returns the row when present, undefined otherwise", async () => {
    await repo.create(sample("cto"));
    const found = await repo.findBySlug("cto");
    expect(found?.slug).toBe("cto");
    const missing = await repo.findBySlug("missing");
    expect(missing).toBeUndefined();
  });

  it("findAll() returns every library expert", async () => {
    await repo.create(sample("cto"));
    await repo.create(sample("pm"));
    const all = await repo.findAll();
    expect(all.map((e) => e.slug).sort()).toEqual(["cto", "pm"]);
  });

  it("update() patches columns and refreshes updated_at", async () => {
    const created = await repo.create(sample("cto"));
    await new Promise((r) => setTimeout(r, 10));
    await repo.update("cto", { displayName: "New Name", yamlChecksum: "def456" });
    const after = await repo.findBySlug("cto");
    expect(after?.displayName).toBe("New Name");
    expect(after?.yamlChecksum).toBe("def456");
    expect(after?.updatedAt >= created.updatedAt).toBe(true);
  });

  it("delete() removes the row", async () => {
    await repo.create(sample("cto"));
    await repo.delete("cto");
    expect(await repo.findBySlug("cto")).toBeUndefined();
  });

  it("findPanelsForExpert() returns panel names that include the expert", async () => {
    await repo.create(sample("cto"));
    const now = new Date().toISOString();
    await db
      .insertInto("panel_library")
      .values({
        name: "arch-review",
        description: null,
        yaml_path: "/tmp/Council/panels/arch-review.yaml",
        yaml_checksum: "p1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("panel_library")
      .values({
        name: "platform",
        description: null,
        yaml_path: "/tmp/Council/panels/platform.yaml",
        yaml_checksum: "p2",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("panel_members")
      .values({ panel_name: "arch-review", expert_slug: "cto", position: 0, created_at: now })
      .execute();
    await db
      .insertInto("panel_members")
      .values({ panel_name: "platform", expert_slug: "cto", position: 1, created_at: now })
      .execute();

    const panels = await repo.findPanelsForExpert("cto");
    expect([...panels].sort()).toEqual(["arch-review", "platform"]);

    const none = await repo.findPanelsForExpert("nobody");
    expect(none).toEqual([]);
  });
});

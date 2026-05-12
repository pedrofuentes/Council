/**
 * Tests for PanelLibraryRepository — typed CRUD over the panel_library
 * and panel_members tables (migration 004).
 *
 * RED at this commit: src/memory/repositories/panel-library-repo.ts does
 * not yet exist.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  ExpertLibraryRepository,
  type NewLibraryExpert,
} from "../../../src/memory/repositories/expert-library-repo.js";
import {
  PanelLibraryRepository,
  type NewLibraryPanel,
} from "../../../src/memory/repositories/panel-library-repo.js";

function panelSample(name = "arch-review"): NewLibraryPanel {
  return {
    name,
    description: "Multi-perspective review",
    yamlPath: `/tmp/Council/panels/${name}.yaml`,
    yamlChecksum: "checksum-abc",
  };
}

function expertSample(slug: string): NewLibraryExpert {
  return {
    slug,
    kind: "generic",
    displayName: slug.toUpperCase(),
    yamlPath: `/tmp/Council/experts/${slug}.yaml`,
    yamlChecksum: `chk-${slug}`,
  };
}

describe("PanelLibraryRepository", () => {
  let db: CouncilDatabase;
  let repo: PanelLibraryRepository;
  let experts: ExpertLibraryRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    repo = new PanelLibraryRepository(db);
    experts = new ExpertLibraryRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() inserts a row and returns the domain object with timestamps", async () => {
    const created = await repo.create(panelSample("arch-review"));
    expect(created.name).toBe("arch-review");
    expect(created.description).toBe("Multi-perspective review");
    expect(created.yamlPath).toContain("arch-review.yaml");
    expect(created.yamlChecksum).toBe("checksum-abc");
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("create() handles missing description as null", async () => {
    const created = await repo.create({
      name: "minimal",
      yamlPath: "/tmp/Council/panels/minimal.yaml",
      yamlChecksum: "x",
    });
    expect(created.description).toBeNull();
  });

  it("findByName() returns row when present, undefined otherwise", async () => {
    await repo.create(panelSample("arch-review"));
    const found = await repo.findByName("arch-review");
    expect(found?.name).toBe("arch-review");
    expect(await repo.findByName("missing")).toBeUndefined();
  });

  it("findAll() returns every panel sorted by name", async () => {
    await repo.create(panelSample("zeta"));
    await repo.create(panelSample("alpha"));
    const all = await repo.findAll();
    expect(all.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  it("delete() removes the row and cascades panel_members", async () => {
    await experts.create(expertSample("cto"));
    await repo.create(panelSample("arch-review"));
    await repo.setMembers("arch-review", ["cto"]);
    await repo.delete("arch-review");
    expect(await repo.findByName("arch-review")).toBeUndefined();
    expect(await repo.getMembers("arch-review")).toEqual([]);
  });

  it("setMembers() stores expert slugs in order with positions", async () => {
    await experts.create(expertSample("cto"));
    await experts.create(expertSample("staff"));
    await experts.create(expertSample("sre"));
    await repo.create(panelSample("arch-review"));

    await repo.setMembers("arch-review", ["cto", "staff", "sre"]);
    const members = await repo.getMembers("arch-review");
    expect(members).toEqual(["cto", "staff", "sre"]);
  });

  it("setMembers() replaces existing membership", async () => {
    await experts.create(expertSample("cto"));
    await experts.create(expertSample("staff"));
    await experts.create(expertSample("sre"));
    await repo.create(panelSample("arch-review"));

    await repo.setMembers("arch-review", ["cto", "staff"]);
    await repo.setMembers("arch-review", ["sre"]);
    expect(await repo.getMembers("arch-review")).toEqual(["sre"]);
  });

  it("getMembers() returns members in stored position order", async () => {
    await experts.create(expertSample("a"));
    await experts.create(expertSample("b"));
    await experts.create(expertSample("c"));
    await repo.create(panelSample("ordered"));
    await repo.setMembers("ordered", ["c", "a", "b"]);
    expect(await repo.getMembers("ordered")).toEqual(["c", "a", "b"]);
  });
});

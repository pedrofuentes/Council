import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as yaml from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPanelAuthoringSource,
  validatePanelName,
  type PanelAuthoringDeps,
} from "../../../src/tui/adapters/panel-authoring.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../src/memory/repositories/panel-library-repo.js";
import { copyTemplateDb } from "../../helpers/template-db.js";
import { mkCanonicalTempDir } from "../../helpers/tmp.js";

interface TestEnv {
  readonly home: string;
  readonly db: CouncilDatabase;
  readonly panelRepo: PanelLibraryRepository;
  readonly knownExperts: Set<string>;
}

type RecordedPanelRepo = PanelAuthoringDeps["panelRepo"] & {
  readonly events: string[];
};

async function makeEnv(): Promise<TestEnv> {
  const home = await mkCanonicalTempDir("council-panel-authoring-");
  await copyTemplateDb(path.join(home, "council.db"));
  const db = await createDatabase(path.join(home, "council.db"));
  const knownExperts = new Set(["alice", "bob", "carol"]);
  const now = new Date().toISOString();
  await db
    .insertInto("expert_library")
    .values(
      [...knownExperts].map((slug) => ({
        slug,
        kind: "persona",
        display_name: slug,
        yaml_path: `${slug}.yaml`,
        yaml_checksum: "x",
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  return {
    home,
    db,
    panelRepo: new PanelLibraryRepository(db),
    knownExperts,
  };
}

async function teardown(env: TestEnv): Promise<void> {
  await env.db.destroy().catch(() => undefined);
  for (let i = 0; i < 5; i += 1) {
    try {
      await fs.rm(env.home, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function sourceFor(env: TestEnv, overrides: Partial<PanelAuthoringDeps> = {}) {
  return createPanelAuthoringSource({
    panelRepo: env.panelRepo,
    expertExists: async (slug) => env.knownExperts.has(slug),
    dataHome: env.home,
    countDebates: async () => 0,
    ...overrides,
  });
}

function recordingRepo(env: TestEnv, events: string[] = []): RecordedPanelRepo {
  return {
    events,
    async create(input) {
      events.push("row");
      return env.panelRepo.create(input);
    },
    async findByName(name) {
      return env.panelRepo.findByName(name);
    },
    async delete(name) {
      events.push("delete-row");
      return env.panelRepo.delete(name);
    },
    async setMembers(name, slugs) {
      const yamlPath = path.join(env.home, "panels", `${name}.yaml`);
      await expect(fs.access(yamlPath)).resolves.toBeUndefined();
      events.push("members");
      return env.panelRepo.setMembers(name, slugs);
    },
  };
}

async function createExistingPanel(env: TestEnv, name = "alpha"): Promise<void> {
  await sourceFor(env).create({
    name,
    description: "Existing panel",
    expertSlugs: ["alice"],
  });
}

describe("validatePanelName", () => {
  it.each(["a", "a-b1"])("accepts %s", (name) => {
    expect(() => validatePanelName(name)).not.toThrow();
  });

  it.each(["", "A", "1x", "a_b", "-a"])("rejects %s", (name) => {
    expect(() => validatePanelName(name)).toThrow(/kebab-case.*start with a letter/i);
  });
});

describe("createPanelAuthoringSource", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("creates a panel row, YAML, members, and docs directory in order", async () => {
    const events: string[] = [];
    const repo = recordingRepo(env, events);
    const source = sourceFor(env, { panelRepo: repo });

    await source.create({
      name: "alpha",
      description: "Alpha panel",
      expertSlugs: ["alice", "bob"],
      maxRounds: 3,
      model: "gpt-test",
    });

    expect(events).toEqual(["row", "members"]);
    await expect(env.panelRepo.findByName("alpha")).resolves.toMatchObject({
      name: "alpha",
      description: "Alpha panel",
    });
    const yamlPath = path.join(env.home, "panels", "alpha.yaml");
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8"));
    expect(parsed).toMatchObject({
      name: "alpha",
      description: "Alpha panel",
      defaults: { mode: "freeform", maxRounds: 3, model: "gpt-test" },
      experts: ["alice", "bob"],
    });
    await expect(env.panelRepo.getMembers("alpha")).resolves.toEqual(["alice", "bob"]);
    expect((await fs.stat(path.join(env.home, "panels", "alpha", "docs"))).isDirectory()).toBe(
      true,
    );
  });

  it("honors an explicit mode when building defaults", async () => {
    await sourceFor(env).create({
      name: "alpha",
      description: null,
      expertSlugs: ["alice"],
      mode: "structured",
    });

    const parsed = yaml.parse(
      await fs.readFile(path.join(env.home, "panels", "alpha.yaml"), "utf-8"),
    );
    expect(parsed.defaults).toEqual({ mode: "structured" });
  });

  it("rejects duplicate names without writing a second YAML", async () => {
    await createExistingPanel(env, "alpha");
    const yamlPath = path.join(env.home, "panels", "alpha.yaml");
    const before = await fs.readFile(yamlPath, "utf-8");

    await expect(
      sourceFor(env).create({ name: "alpha", description: null, expertSlugs: ["bob"] }),
    ).rejects.toThrow(/panel .*alpha.*already exists/i);

    await expect(fs.readFile(yamlPath, "utf-8")).resolves.toBe(before);
    await expect(env.panelRepo.getMembers("alpha")).resolves.toEqual(["alice"]);
  });

  it("rejects an unknown member before creating DB rows or YAML", async () => {
    await expect(
      sourceFor(env).create({ name: "alpha", description: null, expertSlugs: ["missing"] }),
    ).rejects.toThrow(/expert .*missing.*not found/i);

    await expect(env.panelRepo.findByName("alpha")).resolves.toBeUndefined();
    await expect(fs.access(path.join(env.home, "panels", "alpha.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back the DB row when the YAML already exists on disk", async () => {
    const yamlPath = path.join(env.home, "panels", "alpha.yaml");
    await fs.mkdir(path.dirname(yamlPath), { recursive: true });
    await fs.writeFile(yamlPath, "pre-existing", "utf-8");

    await expect(
      sourceFor(env).create({ name: "alpha", description: null, expertSlugs: ["alice"] }),
    ).rejects.toThrow(/panel YAML already exists|already exists at/i);

    await expect(env.panelRepo.findByName("alpha")).resolves.toBeUndefined();
    await expect(fs.readFile(yamlPath, "utf-8")).resolves.toBe("pre-existing");
  });

  it("rolls back the DB row when YAML open fails for a non-collision reason", async () => {
    const panelsDir = path.join(env.home, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.chmod(panelsDir, 0o555);
    try {
      await expect(
        sourceFor(env).create({ name: "alpha", description: null, expertSlugs: ["alice"] }),
      ).rejects.toThrow();
    } finally {
      await fs.chmod(panelsDir, 0o755);
    }

    await expect(env.panelRepo.findByName("alpha")).resolves.toBeUndefined();
    await expect(fs.access(path.join(env.home, "panels", "alpha.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back the DB row and YAML when setMembers fails", async () => {
    const repo = recordingRepo(env);
    const failingRepo: PanelAuthoringDeps["panelRepo"] = {
      ...repo,
      async setMembers(): Promise<void> {
        throw new Error("forced setMembers failure");
      },
    };

    await expect(
      sourceFor(env, { panelRepo: failingRepo }).create({
        name: "alpha",
        description: null,
        expertSlugs: ["alice"],
      }),
    ).rejects.toThrow(/forced setMembers failure/);

    await expect(env.panelRepo.findByName("alpha")).resolves.toBeUndefined();
    await expect(fs.access(path.join(env.home, "panels", "alpha.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates members after validating all expert slugs", async () => {
    await createExistingPanel(env, "alpha");
    const source = sourceFor(env);

    await source.setMembers("alpha", ["bob", "carol"]);
    await expect(env.panelRepo.getMembers("alpha")).resolves.toEqual(["bob", "carol"]);

    await expect(source.setMembers("alpha", ["missing"])).rejects.toThrow(
      /expert .*missing.*not found/i,
    );
    await expect(env.panelRepo.getMembers("alpha")).resolves.toEqual(["bob", "carol"]);
  });

  it.each([0, 3])("delegates retained debate count %i", async (count) => {
    const calls: string[] = [];
    const source = sourceFor(env, {
      countDebates: async (name) => {
        calls.push(name);
        return count;
      },
    });

    await expect(source.countRetainedDebates("alpha")).resolves.toBe(count);
    expect(calls).toEqual(["alpha"]);
  });

  it("deletes YAML, panel directory, and DB row while rejecting missing panels", async () => {
    await createExistingPanel(env, "alpha");
    const panelDir = path.join(env.home, "panels", "alpha");
    await fs.writeFile(path.join(panelDir, "docs", "note.md"), "doc", "utf-8");

    const source = sourceFor(env);
    await source.delete("alpha");

    await expect(fs.access(path.join(env.home, "panels", "alpha.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(panelDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(env.panelRepo.findByName("alpha")).resolves.toBeUndefined();

    await expect(source.delete("missing")).rejects.toThrow(/panel .*missing.*not found/i);
  });

  it("ignores an already-missing YAML file during delete", async () => {
    await createExistingPanel(env, "alpha");
    await fs.unlink(path.join(env.home, "panels", "alpha.yaml"));

    await sourceFor(env).delete("alpha");

    await expect(env.panelRepo.findByName("alpha")).resolves.toBeUndefined();
  });

  it("preserves the DB row when delete cannot unlink the YAML path", async () => {
    await createExistingPanel(env, "alpha");
    const yamlPath = path.join(env.home, "panels", "alpha.yaml");
    await fs.unlink(yamlPath);
    await fs.mkdir(yamlPath);

    await expect(sourceFor(env).delete("alpha")).rejects.toThrow();

    await expect(env.panelRepo.findByName("alpha")).resolves.toMatchObject({ name: "alpha" });
  });

  it("surfaces actionable recovery guidance and preserves the row when the DB delete fails after FS removal (#1643)", async () => {
    await createExistingPanel(env, "arch-review");
    const yamlPath = path.join(env.home, "panels", "arch-review.yaml");
    const dir = path.join(env.home, "panels", "arch-review");

    const delSpy = vi
      .spyOn(PanelLibraryRepository.prototype, "delete")
      .mockRejectedValueOnce(new Error("EIO: simulated DB delete failure"));

    const source = sourceFor(env);
    const err = await source.delete("arch-review").then(
      () => null,
      (e: unknown) => e,
    );

    // The DB delete was attempted only after the FS artifacts were removed
    // (FS-first ordering keeps the row authoritative for a retry) ...
    expect(delSpy).toHaveBeenCalledTimes(1);
    await expect(fs.access(yamlPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(dir)).rejects.toMatchObject({ code: "ENOENT" });
    // ... the panel_library row is NOT silently lost — it remains for a retry ...
    await expect(env.panelRepo.findByName("arch-review")).resolves.toMatchObject({
      name: "arch-review",
    });
    // ... and the surfaced error carries the actionable recovery phrase so the
    // operator can clear the stale row (mirrors the CLI `panel delete`).
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/re-run[^]*council panel delete[^]*arch-review/i);

    // Re-runnable to a clean state: with the DB healthy, a second delete
    // tolerates the now-missing YAML/dir and clears the stale row.
    delSpy.mockRestore();
    await source.delete("arch-review");
    await expect(env.panelRepo.findByName("arch-review")).resolves.toBeUndefined();
  });
});

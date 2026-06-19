/**
 * Tests for `council panel create --slug <slug>` (T9 / F29).
 *
 * `expert create` uses `--slug`; `panel create` historically only accepted
 * a positional `<name>`. For UX consistency, `panel create` must also
 * accept `--slug` as an alias. The positional form remains for
 * backward compatibility, and passing both forms must error.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-slug-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-slug-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: {
      weightedEvidence: ["evidence"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Empirical",
    kind: "generic",
  };
}

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

describe("panel create --slug", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("creates a panel when only --slug is provided (no positional)", async () => {
    await seedExpert(env, expertDef("cto"));
    let captured = "";
    const cmd = buildPanelCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "--slug",
      "slug-only-panel",
      "--experts",
      "cto",
    ]);
    expect(captured).toContain("slug-only-panel");
    const yamlPath = path.join(env.dataHome, "panels", "slug-only-panel.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");
    expect(content).toContain("name: slug-only-panel");
  });

  it("still works with positional <name> (backward compat)", async () => {
    await seedExpert(env, expertDef("cto"));
    let captured = "";
    const cmd = buildPanelCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "positional-panel",
      "--experts",
      "cto",
    ]);
    expect(captured).toContain("positional-panel");
    const yamlPath = path.join(env.dataHome, "panels", "positional-panel.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");
    expect(content).toContain("name: positional-panel");
  });

  it("errors when both positional <name> and --slug are provided", async () => {
    await seedExpert(env, expertDef("cto"));
    let errored = "";
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      (s) => {
        errored += s;
      },
    );
    await expect(
      cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "positional-name",
        "--slug",
        "slug-name",
        "--experts",
        "cto",
      ]),
    ).rejects.toThrow(/both|either|conflict|slug|positional/i);
    expect(errored.length).toBeGreaterThan(0);
  });

  it("errors when neither positional <name> nor --slug is provided", async () => {
    await seedExpert(env, expertDef("cto"));
    let errored = "";
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      (s) => {
        errored += s;
      },
    );
    await expect(
      cmd.parseAsync(["node", "council-panel", "create", "--experts", "cto"]),
    ).rejects.toThrow(/name|required|slug/i);
    expect(errored).toMatch(/name|required|slug/i);
  });
});

/**
 * Tests that `council panel create --experts` reliably captures EVERY expert
 * across all the shell forms users hit in practice (T7).
 *
 * Same foot-gun as convene: `--experts <slugs>` was single-value, so on
 * PowerShell an unquoted `--experts a,b,c` is shell-split into
 * `--experts a b c` and Commander silently kept only `a`, creating a
 * one-expert panel with no warning. `--experts` is now variadic, so the
 * space form, the quoted comma form and the repeated form all resolve to the
 * full expert set, identically to convene.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-multiexp-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-multiexp-data-"));
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

async function panelExpertSlugs(env: TestEnv, panelName: string): Promise<readonly string[]> {
  const yamlPath = path.join(env.dataHome, "panels", `${panelName}.yaml`);
  const content = await fs.readFile(yamlPath, "utf-8");
  const parsed = parseYaml(content) as { experts?: readonly string[] };
  return [...(parsed.experts ?? [])].sort();
}

describe("panel create --experts (multi-value capture, T7)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
    await seedExpert(env, expertDef("cto"));
    await seedExpert(env, expertDef("cmo"));
    await seedExpert(env, expertDef("cfo"));
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("space-separated form (--experts cto cmo cfo) captures all three", async () => {
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "space-panel",
      "--experts",
      "cto",
      "cmo",
      "cfo",
    ]);
    expect(await panelExpertSlugs(env, "space-panel")).toEqual(["cfo", "cmo", "cto"]);
  });

  it("quoted comma form (--experts cto,cmo,cfo) captures all three", async () => {
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "comma-panel",
      "--experts",
      "cto,cmo,cfo",
    ]);
    expect(await panelExpertSlugs(env, "comma-panel")).toEqual(["cfo", "cmo", "cto"]);
  });

  it("repeated form (--experts cto --experts cmo --experts cfo) captures all three", async () => {
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "repeat-panel",
      "--experts",
      "cto",
      "--experts",
      "cmo",
      "--experts",
      "cfo",
    ]);
    expect(await panelExpertSlugs(env, "repeat-panel")).toEqual(["cfo", "cmo", "cto"]);
  });

  it("mixed comma + repeated form de-duplicates and captures the union", async () => {
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "mixed-panel",
      "--experts",
      "cto,cmo",
      "--experts",
      "cmo,cfo",
    ]);
    expect(await panelExpertSlugs(env, "mixed-panel")).toEqual(["cfo", "cmo", "cto"]);
  });

  it("never silently collapses the space form to a single expert", async () => {
    const cmd = buildPanelCommand(
      () => undefined,
      () => undefined,
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "nodrop-panel",
      "--experts",
      "cto",
      "cmo",
      "cfo",
    ]);
    const slugs = await panelExpertSlugs(env, "nodrop-panel");
    expect(slugs).toHaveLength(3);
    expect(slugs).not.toEqual(["cto"]);
  });

  it("warns (does not silently ignore) when bare slugs are passed without --experts", async () => {
    const stderr: string[] = [];
    const cmd = buildPanelCommand(
      () => undefined,
      (s) => {
        stderr.push(s);
      },
    );
    // `cmo` and `cfo` are stray bare operands; `--experts cto` still creates a
    // valid panel so the command completes.
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "stray-panel",
      "cmo",
      "cfo",
      "--experts",
      "cto",
    ]);
    const combined = stderr.join("");
    expect(combined).toMatch(/cmo/);
    expect(combined).toMatch(/cfo/);
    expect(combined).toMatch(/--experts/);
  });
});

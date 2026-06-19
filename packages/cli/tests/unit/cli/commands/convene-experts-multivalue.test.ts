/**
 * Tests that `council convene --experts` reliably captures EVERY expert
 * across all the shell forms users hit in practice (T7).
 *
 * The original failure: `--experts <slugs>` was a single-value option, so on
 * PowerShell an unquoted `--experts a,b,c` is split by the shell into
 * `--experts a b c`. Commander then bound only `a` to `--experts` and silently
 * dropped `b`/`c` as ignored positionals — a one-expert panel with no warning.
 *
 * `--experts` is now a variadic option, so the space form, the quoted comma
 * form, and the repeated form all resolve to the full expert set, and stray
 * bare operands produce a warning instead of vanishing.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-multiexp-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-multiexp-data-"));
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
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

async function persistedPanelExpertSlugs(env: TestEnv): Promise<readonly string[]> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const panels = await new PanelRepository(db).findAll();
    expect(panels).toHaveLength(1);
    const panelRow = panels[0];
    if (!panelRow) throw new Error("no panel persisted");
    const experts = await new ExpertRepository(db).findByPanelId(panelRow.id);
    return experts.map((e) => e.slug).sort();
  } finally {
    await db.destroy();
  }
}

describe("convene --experts (multi-value capture, T7)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
    await seedExpert(env, expertDef("alpha"));
    await seedExpert(env, expertDef("beta"));
    await seedExpert(env, expertDef("gamma"));
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("space-separated form (--experts alpha beta gamma) captures all three", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--experts",
      "alpha",
      "beta",
      "gamma",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
    expect(await persistedPanelExpertSlugs(env)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("quoted comma form (--experts alpha,beta,gamma) captures all three", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--experts",
      "alpha,beta,gamma",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
    expect(await persistedPanelExpertSlugs(env)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("repeated form (--experts alpha --experts beta --experts gamma) captures all three", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--experts",
      "alpha",
      "--experts",
      "beta",
      "--experts",
      "gamma",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
    expect(await persistedPanelExpertSlugs(env)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("mixed comma + repeated form de-duplicates and captures the union", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--experts",
      "alpha,beta",
      "--experts",
      "beta,gamma",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
    expect(await persistedPanelExpertSlugs(env)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("never silently collapses the space form to a single expert", async () => {
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--experts",
      "alpha",
      "beta",
      "gamma",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
    const slugs = await persistedPanelExpertSlugs(env);
    expect(slugs).toHaveLength(3);
    expect(slugs).not.toEqual(["alpha"]);
  });

  it("warns (does not silently ignore) when bare slugs are passed without --experts", async () => {
    const stderr: string[] = [];
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s: string) => {
        stderr.push(s);
      },
    });
    // `beta` and `gamma` are stray bare operands; `--experts alpha` still drives
    // a normal (mock) debate so the run completes deterministically.
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "beta",
      "gamma",
      "--experts",
      "alpha",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
    const combined = stderr.join("");
    expect(combined).toMatch(/beta/);
    expect(combined).toMatch(/gamma/);
    expect(combined).toMatch(/--experts/);
  });
});

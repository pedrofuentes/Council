/**
 * Tests for `council convene --experts <slugs>` (T9 / F31).
 *
 * `--experts` is a third panel-selection path alongside `--template` /
 * `--panel` (use a template) and the default auto-compose path (LLM-design
 * a panel). When `--experts` is provided, Council loads each slug from
 * the FileExpertLibrary and builds the panel directly — no template, no
 * auto-compose.
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

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-experts-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-experts-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
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

describe("convene --experts", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("registers --experts option", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    const opt = cmd.options.find((o) => o.long === "--experts");
    expect(opt).toBeDefined();
  });

  it("with --experts: loads experts from library, runs debate, persists panel", async () => {
    await seedExpert(env, expertDef("alpha"));
    await seedExpert(env, expertDef("beta"));

    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Ad-hoc topic",
      "--experts",
      "alpha,beta",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const panelRow = panels[0];
      if (!panelRow) throw new Error("no panel persisted");
      expect(panelRow.topic).toBe("Ad-hoc topic");
      const experts = await new ExpertRepository(db).findByPanelId(panelRow.id);
      const slugs = experts.map((e) => e.slug).sort();
      expect(slugs).toEqual(["alpha", "beta"]);
    } finally {
      await db.destroy();
    }
  });

  it("with --experts AND --template: errors", async () => {
    await seedExpert(env, expertDef("alpha"));
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Topic",
        "--experts",
        "alpha",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/experts.*template|template.*experts|both|mutually/i);
  });

  it("with --experts referencing an unknown slug: errors with helpful message", async () => {
    await seedExpert(env, expertDef("alpha"));
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
    });
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Topic",
        "--experts",
        "alpha,ghost",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/ghost|not found|unknown|missing/i);
  });
});

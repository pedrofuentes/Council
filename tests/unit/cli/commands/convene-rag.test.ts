/**
 * Tests for `council convene` retrieval-augmented prompts (T1 RAG fix).
 *
 * Before this change convene/debate NEVER surfaced indexed documents to the
 * experts — only the moderator-built topic prompt reached the engine, so
 * planted facts (an MRR figure in an indexed spreadsheet, etc.) never
 * appeared. This test indexes a document containing a unique figure, runs
 * convene over an ad-hoc panel (`--experts`, which scopes retrieval to
 * `sources:'all'`), and asserts the figure reaches the engine inside the
 * shared `[REFERENCE DOCUMENTS]` block.
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
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-rag-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-rag-data-"));
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

async function indexDoc(
  env: TestEnv,
  doc: { readonly content: string; readonly sourceType: "expert" | "panel"; readonly sourceSlug: string; readonly filePath: string },
): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const indexer = createDocumentIndexer(db);
    await indexer.index(doc);
  } finally {
    await db.destroy();
  }
}

describe("convene — RAG document injection", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("injects retrieved document snippets (a planted figure) into the expert prompts", async () => {
    await seedExpert(env, expertDef("alpha"));
    await seedExpert(env, expertDef("beta"));
    await indexDoc(env, {
      content:
        "Finance review: the planted revenue figure is 73471 dollars in recurring monthly revenue this quarter.",
      sourceType: "panel",
      sourceSlug: "finance-docs",
      filePath: "/docs/panels/finance-docs/mrr.xlsx",
    });

    const engines: MockEngine[] = [];
    const engineFactory = (): CouncilEngine => {
      const engine = new MockEngine({ responses: {} });
      engines.push(engine);
      return engine;
    };

    const cmd = buildConveneCommand({
      engineFactory,
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "planted revenue figure",
      "--experts",
      "alpha,beta",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    const prompts = engines.flatMap((engine) => engine.sentPrompts.map((p) => p.prompt));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes("[REFERENCE DOCUMENTS]"))).toBe(true);
    expect(prompts.some((p) => p.includes("73471"))).toBe(true);
  });
});

/**
 * RAG per-turn char-budget cap at the interactive chat sinks (#1091).
 *
 * T01 changed `createDocumentRetriever` to return each matched chunk's FULL
 * `content` (bounded ~1200 chars/chunk) instead of a 64-token `snippet(...)`.
 * The 1:1 (`expert-chat`) and panel (`panel-chat`) turn sinks assemble those
 * chunks into the model prompt via `appendReferenceDocuments`, but — unlike
 * the convene/debate path — did NOT apply the shared per-turn budget
 * (`capSnippetsByChars`, `REFERENCE_DOCS_CHAR_CAP` = 4000 chars). With
 * `maxResults: 5`, worst-case injected reference text grew to ~6000 chars/turn.
 *
 * These tests index a document large enough that retrieval genuinely exceeds
 * the budget, then assert the injected excerpt text is capped at BOTH sinks —
 * and, inversely, that under-budget retrieval is passed through byte-identical
 * (no accidental truncation of small results).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand, type ChatInputProvider } from "../../../../src/cli/commands/chat.js";
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";
import {
  createDocumentRetriever,
  type DocumentSnippet,
  type RetrieveOptions,
} from "../../../../src/core/documents/retriever.js";
import { REFERENCE_DOCS_CHAR_CAP } from "../../../../src/core/documents/reference-block.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-ragcap-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ragcap-data-"));
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

const EXPERT: ExpertDefinition = {
  slug: "dahlia-cto",
  displayName: "Dahlia Renner (CTO)",
  role: "Skeptical CTO with 20 years of experience",
  expertise: {
    weightedEvidence: ["production incident data"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Bayesian skeptic",
  kind: "generic",
};

const PANEL_EXPERT_A: ExpertDefinition = {
  slug: "panel-a",
  displayName: "Alice (Architect)",
  role: "Systems architect",
  expertise: { weightedEvidence: ["postmortems"], referenceCases: [], notExpertIn: [] },
  epistemicStance: "Engineering rigor",
  kind: "generic",
};

const PANEL_EXPERT_B: ExpertDefinition = {
  slug: "panel-b",
  displayName: "Bob (Builder)",
  role: "Implementation lead",
  expertise: { weightedEvidence: ["shipping cadence"], referenceCases: [], notExpertIn: [] },
  epistemicStance: "Pragmatist",
  kind: "generic",
};

/**
 * A document that chunks into far more than `maxResults` (5) bounded chunks,
 * each matching the query token. Retrieval therefore returns 5 full chunks
 * (~6000 chars total) — comfortably over the 4000-char per-turn budget — so
 * the cap has something to trim. (Empirically ~11 chunks of ~1196 chars.)
 */
const OVER_BUDGET_CONTENT = "widgetkeyword filler ".repeat(600).trim();

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    await new FileExpertLibrary(env.dataHome, db).create(def);
  } finally {
    await db.destroy();
  }
}

async function writeUserPanel(
  env: TestEnv,
  name: string,
  experts: readonly string[],
): Promise<void> {
  const dir = path.join(env.dataHome, "panels");
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    "description: RAG cap test panel",
    "experts:",
    ...experts.map((s) => `  - ${s}`),
  ];
  await fs.writeFile(path.join(dir, `${name}.yaml`), lines.join("\n") + "\n", "utf-8");
}

async function indexDoc(
  env: TestEnv,
  sourceType: "expert" | "panel",
  sourceSlug: string,
  filePath: string,
  content: string,
): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    await createDocumentIndexer(db).index({ content, sourceType, sourceSlug, filePath });
  } finally {
    await db.destroy();
  }
}

/**
 * Ground-truth retrieval against the same index the chat sink queries, so a
 * test can assert what the UNCAPPED retrieval returns (its chunk count and
 * combined length) without coupling to the sink's internal cap.
 */
async function retrieveDirect(
  env: TestEnv,
  query: string,
  options: RetrieveOptions,
): Promise<readonly DocumentSnippet[]> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    return await createDocumentRetriever(db).retrieve(query, options);
  } finally {
    await db.destroy();
  }
}

function scriptedInput(inputLines: readonly string[]): ChatInputProvider {
  let i = 0;
  return {
    async readLine(): Promise<string | null> {
      if (i >= inputLines.length) return null;
      const line = inputLines[i] ?? null;
      i += 1;
      return line;
    },
    close(): void {
      /* no-op */
    },
  };
}

/**
 * Extract the verbatim excerpt bodies injected into a prompt — the text
 * between each per-snippet `---` fence pair emitted by
 * `appendReferenceDocuments`. Lets a test measure how much retrieved content
 * actually reached the model after the per-turn budget was applied.
 */
function extractInjectedExcerpts(prompt: string): readonly string[] {
  const re = /\n---\n([\s\S]*?)\n---\n\[END REFERENCE DOCUMENT\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    out.push(m[1] ?? "");
  }
  return out;
}

function totalLength(parts: readonly string[]): number {
  return parts.reduce((sum, p) => sum + p.length, 0);
}

describe("RAG per-turn char budget at chat sinks (#1091)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("1:1 chat caps multi-chunk RAG excerpts to the per-turn char budget", async () => {
    await seedExpert(env, EXPERT);
    await indexDoc(env, "expert", "dahlia-cto", "/docs/big-memo.md", OVER_BUDGET_CONTENT);

    // Precondition: uncapped retrieval genuinely exceeds the budget.
    const retrieved = await retrieveDirect(env, "widgetkeyword", {
      expertSlug: "dahlia-cto",
      maxResults: 5,
    });
    expect(retrieved.length).toBeGreaterThanOrEqual(2);
    expect(totalLength(retrieved.map((s) => s.content))).toBeGreaterThan(REFERENCE_DOCS_CHAR_CAP);

    const engine = new MockEngine();
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["widgetkeyword", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

    const refPrompts = engine.sentPrompts.filter((p) => p.prompt.includes("[REFERENCE DOCUMENTS]"));
    expect(refPrompts.length).toBe(1);
    const excerpts = extractInjectedExcerpts(refPrompts[0]?.prompt ?? "");
    // Capped: injected excerpt text stays within the per-turn budget...
    expect(totalLength(excerpts)).toBeLessThanOrEqual(REFERENCE_DOCS_CHAR_CAP);
    // ...by dropping the least-relevant trailing chunk(s), not all of them.
    expect(excerpts.length).toBeGreaterThanOrEqual(1);
    expect(excerpts.length).toBeLessThan(retrieved.length);
  });

  it("1:1 chat leaves under-budget RAG excerpts unchanged — no truncation", async () => {
    await seedExpert(env, EXPERT);
    const smallDoc = "the quarterly plan targets alphaunique growth in three regions";
    await indexDoc(env, "expert", "dahlia-cto", "/docs/small.md", smallDoc);

    const retrieved = await retrieveDirect(env, "alphaunique", {
      expertSlug: "dahlia-cto",
      maxResults: 5,
    });
    // Precondition: this retrieval is under budget.
    expect(retrieved.length).toBeGreaterThanOrEqual(1);
    expect(totalLength(retrieved.map((s) => s.content))).toBeLessThanOrEqual(
      REFERENCE_DOCS_CHAR_CAP,
    );

    const engine = new MockEngine();
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["alphaunique", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

    const refPrompts = engine.sentPrompts.filter((p) => p.prompt.includes("[REFERENCE DOCUMENTS]"));
    expect(refPrompts.length).toBe(1);
    const excerpts = extractInjectedExcerpts(refPrompts[0]?.prompt ?? "");
    // Every retrieved chunk survives, byte-identical (cap is a no-op here).
    expect(excerpts.length).toBe(retrieved.length);
    expect(excerpts.join("\n")).toBe(retrieved.map((s) => s.content).join("\n"));
  });

  it("panel chat caps multi-chunk RAG excerpts to the per-turn budget for every panelist", async () => {
    await seedExpert(env, PANEL_EXPERT_A);
    await seedExpert(env, PANEL_EXPERT_B);
    await writeUserPanel(env, "rag-panel", ["panel-a", "panel-b"]);
    await indexDoc(
      env,
      "panel",
      "rag-panel",
      "/panels/rag-panel/docs/big-charter.md",
      OVER_BUDGET_CONTENT,
    );

    const retrieved = await retrieveDirect(env, "widgetkeyword", {
      panelName: "rag-panel",
      maxResults: 5,
    });
    expect(retrieved.length).toBeGreaterThanOrEqual(2);
    expect(totalLength(retrieved.map((s) => s.content))).toBeGreaterThan(REFERENCE_DOCS_CHAR_CAP);

    const engine = new MockEngine();
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["widgetkeyword", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "rag-panel", "--engine", "mock"]);

    const refPrompts = engine.sentPrompts.filter((p) => p.prompt.includes("[REFERENCE DOCUMENTS]"));
    // One prompt per panelist (2 experts) — the shared, capped reference block.
    expect(refPrompts.length).toBe(2);
    for (const p of refPrompts) {
      const excerpts = extractInjectedExcerpts(p.prompt);
      expect(totalLength(excerpts)).toBeLessThanOrEqual(REFERENCE_DOCS_CHAR_CAP);
      expect(excerpts.length).toBeGreaterThanOrEqual(1);
      expect(excerpts.length).toBeLessThan(retrieved.length);
    }
  });

  it("panel chat leaves under-budget RAG excerpts unchanged — no truncation", async () => {
    await seedExpert(env, PANEL_EXPERT_A);
    await seedExpert(env, PANEL_EXPERT_B);
    await writeUserPanel(env, "rag-panel", ["panel-a", "panel-b"]);
    const smallDoc = "the charter mandates betaunique architecture reviews each quarter";
    await indexDoc(env, "panel", "rag-panel", "/panels/rag-panel/docs/small-charter.md", smallDoc);

    const retrieved = await retrieveDirect(env, "betaunique", {
      panelName: "rag-panel",
      maxResults: 5,
    });
    expect(retrieved.length).toBeGreaterThanOrEqual(1);
    expect(totalLength(retrieved.map((s) => s.content))).toBeLessThanOrEqual(
      REFERENCE_DOCS_CHAR_CAP,
    );

    const engine = new MockEngine();
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["betaunique", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "rag-panel", "--engine", "mock"]);

    const refPrompts = engine.sentPrompts.filter((p) => p.prompt.includes("[REFERENCE DOCUMENTS]"));
    expect(refPrompts.length).toBe(2);
    for (const p of refPrompts) {
      const excerpts = extractInjectedExcerpts(p.prompt);
      expect(excerpts.length).toBe(retrieved.length);
      expect(excerpts.join("\n")).toBe(retrieved.map((s) => s.content).join("\n"));
    }
  });
});

/**
 * Tests for chat-startup excludedDocs wiring (#2398) —
 * `maybeProcessPersonaDocs` must honor expert.excludedDocs so documents
 * removed via `expert docs --remove` are not re-indexed on every chat startup.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { maybeProcessPersonaDocs } from "../../../../src/cli/commands/chat/shared.js";
import { createDatabase } from "../../../../src/memory/db.js";
import type { CouncilDatabase } from "../../../../src/memory/db.js";
import { DocumentRepository } from "../../../../src/memory/repositories/document-repository.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import { loadConfig } from "../../../../src/config/index.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";
import type { ChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import { mkCanonicalTempDir } from "../../../helpers/tmp.js";

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────

class StubEngine implements CouncilEngine {
  readonly responses: string[];

  constructor(responses: readonly string[] = []) {
    this.responses = [...responses];
  }

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(_spec: ExpertSpec): Promise<void> {
    /* no-op */
  }
  async removeExpert(_expertId: string): Promise<void> {
    /* no-op */
  }
  async listModels(): Promise<readonly string[]> {
    return ["stub-model"];
  }
  send(opts: SendOptions): AsyncIterable<EngineEvent> {
    const text = this.responses.shift() ?? "";
    const expertId = opts.expertId;
    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      yield { kind: "message.delta", expertId, text };
      yield {
        kind: "message.complete",
        expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

const VALID_PROFILE_JSON = JSON.stringify({
  communicationStyle: "Direct, terse, data-driven.",
  decisionPatterns: ["consult-data-first", "ship-incrementally"],
  biases: ["recency"],
  vocabulary: ["ship", "data"],
  epistemicStance: "Empirical and Bayesian; updates on evidence.",
});

interface Env {
  readonly home: string;
  readonly dataHome: string;
  readonly db: CouncilDatabase;
}

async function makeEnv(): Promise<Env> {
  const home = await mkCanonicalTempDir("council-excludeddocs-");
  const dataHome = await mkCanonicalTempDir("council-excludeddocs-data-");
  await copyTemplateDb(path.join(home, "council.db"));
  const db = await createDatabase(path.join(home, "council.db"));
  return { home, dataHome, db };
}

async function teardown(env: Env): Promise<void> {
  await env.db.destroy().catch(() => undefined);
  for (const dir of [env.home, env.dataHome]) {
    for (let i = 0; i < 5; i += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}

/**
 * Create an expert using FileExpertLibrary (which writes the YAML file and DB row)
 * and seed its docs directory so maybeProcessPersonaDocs can scan it.
 */
async function seedPersonaWithDocs(
  env: Env,
  expert: ExpertDefinition,
  files: readonly { name: string; content: string }[],
): Promise<string> {
  const lib = new FileExpertLibrary(env.dataHome, env.db);
  await lib.create(expert);

  const docsPath = path.join(env.dataHome, "experts", expert.slug, "docs");
  await fs.mkdir(docsPath, { recursive: true });
  for (const file of files) {
    await fs.writeFile(path.join(docsPath, file.name), file.content, "utf-8");
  }
  return docsPath;
}

// Stub renderer — maybeProcessPersonaDocs needs one but we don't inspect output.
const renderer: ChatRenderer = {
  showSystem: (): void => undefined,
  showError: (): void => undefined,
  showExpertThinking: (): void => undefined,
  showExpertResponse: (): void => undefined,
  showUserPrompt: (): void => undefined,
  showProgressStart: (): void => undefined,
  showProgressUpdate: (): void => undefined,
  showProgressEnd: (): void => undefined,
  flush: async (): Promise<void> => undefined,
  close: (): void => undefined,
};

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("maybeProcessPersonaDocs excludedDocs wiring (#2398)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  it("excludes documents listed in expert.excludedDocs from indexing at chat startup", async () => {
    const expert: ExpertDefinition = {
      slug: "alice-researcher",
      displayName: "Alice (Researcher)",
      role: "Data researcher",
      expertise: {
        weightedEvidence: ["papers", "datasets"],
        referenceCases: [],
        notExpertIn: [],
      },
      epistemicStance: "Evidence-based",
      kind: "persona",
      // The key under test: alice has excluded `secret.md`.
      excludedDocs: ["secret.md"],
    };

    await seedPersonaWithDocs(env, expert, [
      { name: "public.md", content: "# Public\nThis is indexable content." },
      { name: "secret.md", content: "# Secret\nThis should NOT be indexed." },
      { name: "readme.txt", content: "Another indexable file." },
    ]);

    // Load the expert from the library so excludedDocs is populated
    const lib = new FileExpertLibrary(env.dataHome, env.db);
    const loadedExpert = await lib.get("alice-researcher");
    if (!loadedExpert) throw new Error("Expert not found");

    const config = await loadConfig(env.home);
    const engine = new StubEngine([VALID_PROFILE_JSON]);

    // Call maybeProcessPersonaDocs — this is the chat-startup path under test.
    await maybeProcessPersonaDocs({
      expert: loadedExpert,
      dataHome: env.dataHome,
      db: env.db,
      engine,
      config,
      renderer,
    });

    // Verify indexing outcome:
    // 1. public.md and readme.txt SHOULD be indexed.
    const indexedRows = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_slug = 'alice-researcher'`.execute(env.db);
    const indexed = indexedRows.rows.map((r) => path.basename(r.file_path)).sort();
    expect(indexed).toEqual(["public.md", "readme.txt"]);

    // 2. secret.md must NOT appear in the index.
    expect(indexed).not.toContain("secret.md");

    // 3. Tracked documents in expert_documents should match the index.
    const docRepo = new DocumentRepository(env.db);
    const tracked = await docRepo.findByExpert("alice-researcher");
    const trackedNames = tracked.map((d) => d.filename).sort();
    expect(trackedNames).toEqual(["public.md", "readme.txt"]);
    expect(trackedNames).not.toContain("secret.md");
  });

  it("indexes all documents when expert.excludedDocs is undefined", async () => {
    const expert: ExpertDefinition = {
      slug: "bob-analyst",
      displayName: "Bob (Analyst)",
      role: "Business analyst",
      expertise: {
        weightedEvidence: ["metrics"],
        referenceCases: [],
        notExpertIn: [],
      },
      epistemicStance: "Data-driven",
      kind: "persona",
      // No excludedDocs — everything should be indexed.
    };

    await seedPersonaWithDocs(env, expert, [
      { name: "report.md", content: "# Q4 Report\nPerformance metrics." },
      { name: "notes.txt", content: "Internal notes." },
    ]);

    const lib = new FileExpertLibrary(env.dataHome, env.db);
    const loadedExpert = await lib.get("bob-analyst");
    if (!loadedExpert) throw new Error("Expert not found");

    const config = await loadConfig(env.home);
    const engine = new StubEngine([VALID_PROFILE_JSON]);

    await maybeProcessPersonaDocs({
      expert: loadedExpert,
      dataHome: env.dataHome,
      db: env.db,
      engine,
      config,
      renderer,
    });

    const indexedRows = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_slug = 'bob-analyst'`.execute(env.db);
    const indexed = indexedRows.rows.map((r) => path.basename(r.file_path)).sort();
    expect(indexed).toEqual(["notes.txt", "report.md"]);
  });

  it("indexes all documents when expert.excludedDocs is an empty array", async () => {
    const expert: ExpertDefinition = {
      slug: "carol-auditor",
      displayName: "Carol (Auditor)",
      role: "Compliance auditor",
      expertise: {
        weightedEvidence: ["policies"],
        referenceCases: [],
        notExpertIn: [],
      },
      epistemicStance: "Risk-averse",
      kind: "persona",
      // Empty excludedDocs — everything should be indexed.
      excludedDocs: [],
    };

    await seedPersonaWithDocs(env, expert, [
      { name: "policy.md", content: "# Policy\nCompliance policy." },
    ]);

    const lib = new FileExpertLibrary(env.dataHome, env.db);
    const loadedExpert = await lib.get("carol-auditor");
    if (!loadedExpert) throw new Error("Expert not found");

    const config = await loadConfig(env.home);
    const engine = new StubEngine([VALID_PROFILE_JSON]);

    await maybeProcessPersonaDocs({
      expert: loadedExpert,
      dataHome: env.dataHome,
      db: env.db,
      engine,
      config,
      renderer,
    });

    const indexedRows = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_slug = 'carol-auditor'`.execute(env.db);
    const indexed = indexedRows.rows.map((r) => path.basename(r.file_path));
    expect(indexed).toEqual(["policy.md"]);
  });
});

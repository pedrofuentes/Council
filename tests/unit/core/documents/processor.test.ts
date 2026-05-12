/**
 * Tests for `createDocumentProcessor` — Roadmap 6.4 on-demand document
 * processing pipeline.
 *
 * Orchestrates: detect changes → extract → index in FTS5 → track in DB
 * → analyze profile via the engine. Errors at any per-file step are
 * isolated (skip-and-continue); a profile-analysis failure preserves the
 * existing profile and surfaces a warning.
 *
 * RED at this commit: src/core/documents/processor.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDocumentProcessor } from "../../../../src/core/documents/processor.js";
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";
import { createDatabase } from "../../../../src/memory/db.js";
import type { CouncilDatabase } from "../../../../src/memory/db.js";
import { DocumentRepository } from "../../../../src/memory/repositories/document-repository.js";
import { ProfileRepository } from "../../../../src/memory/repositories/profile-repository.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";
import { sql } from "kysely";

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────

class StubEngine implements CouncilEngine {
  readonly registered: ExpertSpec[] = [];
  readonly removed: string[] = [];
  readonly sends: { expertId: string; prompt: string }[] = [];
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
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.registered.push(spec);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.removed.push(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["stub-model"];
  }
  send(opts: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push({ expertId: opts.expertId, prompt: opts.prompt });
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
  readonly db: CouncilDatabase;
  readonly docRepo: DocumentRepository;
  readonly profileRepo: ProfileRepository;
  readonly indexer: ReturnType<typeof createDocumentIndexer>;
}

async function makeEnv(): Promise<Env> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-proc-"));
  const db = await createDatabase(path.join(home, "council.db"));
  return {
    home,
    db,
    docRepo: new DocumentRepository(db),
    profileRepo: new ProfileRepository(db),
    indexer: createDocumentIndexer(db),
  };
}

async function teardown(env: Env): Promise<void> {
  await env.db.destroy().catch(() => undefined);
  // Windows holds DB file briefly after close; retry rm on EBUSY.
  for (let i = 0; i < 5; i += 1) {
    try {
      await fs.rm(env.home, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function makeDocsDir(env: Env, slug: string): Promise<string> {
  // Pre-create the expert library row so document_repository FK
  // (expert_documents.expert_slug → expert_library.slug) is satisfied.
  const now = new Date().toISOString();
  await env.db
    .insertInto("expert_library")
    .values({
      slug,
      kind: "persona",
      display_name: slug,
      yaml_path: `${slug}.yaml`,
      yaml_checksum: "x",
      created_at: now,
      updated_at: now,
    })
    .execute();
  const dir = path.join(env.home, "experts", slug, "docs");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const CONFIG = {
  supportedFormats: [".md", ".txt"] as readonly string[],
  recencyHalfLifeDays: 90,
};

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("createDocumentProcessor", () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  describe("needsProcessing()", () => {
    it("returns false when the docs folder does not exist", async () => {
      const proc = createDocumentProcessor({
        engine: new StubEngine(),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      expect(await proc.needsProcessing("nope", "/no/such/path")).toBe(false);
    });

    it("returns false when no supported documents exist", async () => {
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "ignored.bin"), "x");
      const proc = createDocumentProcessor({
        engine: new StubEngine(),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      expect(await proc.needsProcessing("alice", dir)).toBe(false);
    });

    it("returns true when a new document is present", async () => {
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "memo.md"), "# new memo");
      const proc = createDocumentProcessor({
        engine: new StubEngine(),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      expect(await proc.needsProcessing("alice", dir)).toBe(true);
    });

    it("returns false when all documents are unchanged", async () => {
      const dir = await makeDocsDir(env, "alice");
      const filePath = path.join(dir, "memo.md");
      const content = "# stable memo\n\nbody";
      await fs.writeFile(filePath, content);
      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      await proc.process("alice", dir);
      expect(await proc.needsProcessing("alice", dir)).toBe(false);
    });
  });

  describe("process()", () => {
    it("extracts, indexes, tracks each new document, and reports counts", async () => {
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "a.md"), "# A\n\nfirst doc body");
      await fs.writeFile(path.join(dir, "b.txt"), "second doc body");
      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const progress: { filename: string; status: string }[] = [];

      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const result = await proc.process("alice", dir, (p) => {
        progress.push({ filename: p.filename, status: p.status });
      });

      expect(result.filesProcessed).toBe(2);
      expect(result.filesFailed).toBe(0);
      expect(result.totalWords).toBeGreaterThan(0);
      expect(result.profileUpdated).toBe(true);

      // Tracked in the DB.
      const tracked = await env.docRepo.findByExpert("alice");
      expect(tracked.length).toBe(2);
      expect(tracked.every((d) => d.status === "processed")).toBe(true);

      // Indexed in FTS5.
      const rows = await sql<{
        c: number;
      }>`SELECT COUNT(*) AS c FROM document_index WHERE source_slug = 'alice'`.execute(env.db);
      expect(rows.rows[0]?.c).toBe(2);

      // Profile upserted.
      const profile = await env.profileRepo.findBySlug("alice");
      expect(profile?.communicationStyle).toMatch(/data-driven/i);

      // Progress callback fired per file.
      expect(progress.length).toBe(2);
      expect(progress.every((p) => p.status === "success")).toBe(true);
    });

    it("re-processes only modified files on subsequent runs", async () => {
      const dir = await makeDocsDir(env, "alice");
      const fileA = path.join(dir, "a.md");
      const fileB = path.join(dir, "b.md");
      await fs.writeFile(fileA, "original A");
      await fs.writeFile(fileB, "original B");

      const engine = new StubEngine([VALID_PROFILE_JSON, VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const first = await proc.process("alice", dir);
      expect(first.filesProcessed).toBe(2);

      // Modify only file A.
      await fs.writeFile(fileA, "MODIFIED A content");
      const second = await proc.process("alice", dir);
      expect(second.filesProcessed).toBe(1);
      expect(second.filesSkipped).toBe(1);
    });

    it("returns zero counts and skips analysis when the docs folder is empty", async () => {
      const dir = await makeDocsDir(env, "alice");
      const engine = new StubEngine();
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const result = await proc.process("alice", dir);
      expect(result.filesProcessed).toBe(0);
      expect(result.filesFailed).toBe(0);
      expect(result.profileUpdated).toBe(false);
      // Engine never invoked because there were no documents.
      expect(engine.sends.length).toBe(0);
    });

    it("rejects path traversal: docsPath outside the user's data directory is OK only if files are inside it", async () => {
      // Confinement is per-call: every extracted file must canonicalize
      // inside docsPath. We exercise this with a symlink that escapes
      // the docsPath, expecting the file to be reported as failed.
      const dir = await makeDocsDir(env, "alice");
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-outside-"));
      const target = path.join(outside, "secret.md");
      await fs.writeFile(target, "secret");
      const link = path.join(dir, "escape.md");
      try {
        await fs.symlink(target, link);
      } catch {
        // Symlinks unsupported in this environment (e.g. non-admin Win).
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }
      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const progress: { filename: string; status: string; error?: string }[] = [];
      const result = await proc.process("alice", dir, (p) => {
        progress.push({ filename: p.filename, status: p.status, error: p.error });
      });
      await fs.rm(outside, { recursive: true, force: true });

      expect(result.filesFailed).toBe(1);
      expect(result.filesProcessed).toBe(0);
      const failed = progress.find((p) => p.status === "failed");
      expect(failed?.error ?? "").toMatch(/outside|confine|traversal/i);
    });

    it("preserves existing profile when analyzer fails (returns profileUpdated=false)", async () => {
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "a.md"), "first body");

      // Pre-seed an existing profile.
      const existing = {
        communicationStyle: "Existing style.",
        decisionPatterns: ["pattern-1"],
        biases: ["bias-1"],
        vocabulary: ["word-1"],
        epistemicStance: "Existing stance.",
        documentCount: 1,
        totalWords: 1,
        lastUpdated: new Date().toISOString(),
      } as const;
      await env.profileRepo.upsert("alice", existing);

      // Analyzer returns garbage (twice, since analyzeDocuments retries once).
      const engine = new StubEngine(["not json", "still not json"]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const result = await proc.process("alice", dir);
      expect(result.filesProcessed).toBe(1);
      expect(result.profileUpdated).toBe(false);

      const after = await env.profileRepo.findBySlug("alice");
      expect(after?.communicationStyle).toBe("Existing style.");
    });

    it("continues processing when an individual file fails to extract", async () => {
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "good.md"), "good body");
      // A symlink pointing outside the docs folder is rejected by the
      // extractor (confinementRoot violation). The good file must still
      // be processed.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-outside-"));
      const target = path.join(outside, "secret.md");
      await fs.writeFile(target, "secret");
      const link = path.join(dir, "bad.md");
      try {
        await fs.symlink(target, link);
      } catch {
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }

      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const result = await proc.process("alice", dir);
      await fs.rm(outside, { recursive: true, force: true });
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBeGreaterThanOrEqual(1);
    });

    // ── Sentinel pr373 cycle 3 follow-ups ────────────────────────────
    it("rejects a docs root that is itself a symlink/junction (defense in depth)", async () => {
      const dir = await makeDocsDir(env, "alice");
      // Replace the freshly-created dir with a symlink to a sibling.
      await fs.rm(dir, { recursive: true, force: true });
      const realTarget = await fs.mkdtemp(path.join(os.tmpdir(), "council-target-"));
      try {
        await fs.symlink(realTarget, dir, "junction");
      } catch {
        // Symlinks/junctions not supported on this host — skip.
        await fs.rm(realTarget, { recursive: true, force: true });
        return;
      }
      await fs.writeFile(path.join(realTarget, "x.md"), "x");

      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      let threw = false;
      try {
        await proc.process("alice", dir);
      } catch {
        threw = true;
      }
      await fs.rm(realTarget, { recursive: true, force: true });
      expect(threw).toBe(true);
    });

    it("reconciles deleted documents: marks them removed and prunes the FTS index", async () => {
      const dir = await makeDocsDir(env, "alice");
      const fileA = path.join(dir, "a.md");
      const fileB = path.join(dir, "b.md");
      await fs.writeFile(fileA, "alpha body alpha");
      await fs.writeFile(fileB, "beta body beta");

      const engine = new StubEngine([VALID_PROFILE_JSON, VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const first = await proc.process("alice", dir);
      expect(first.filesProcessed).toBe(2);

      // Delete one file, re-run.
      await fs.rm(fileB);
      const second = await proc.process("alice", dir);
      expect(second.filesRemoved).toBe(1);

      // The deleted file should no longer be tracked in expert_documents.
      const remaining = await env.docRepo.getChecksumMap("alice");
      expect(remaining.has(fileB)).toBe(false);
      expect(remaining.has(fileA)).toBe(true);

      // needsProcessing should also recognise a deletion as work to do
      // *before* it is reconciled.
      await fs.writeFile(path.join(dir, "c.md"), "gamma");
      await fs.rm(fileA);
      expect(await proc.needsProcessing("alice", dir)).toBe(true);
    });
  });
});

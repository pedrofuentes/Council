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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDocumentProcessor } from "../../../../src/core/documents/processor.js";
import * as extractorModule from "../../../../src/core/documents/extractor.js";
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import { mkCanonicalTempDir } from "../../../helpers/tmp.js";
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
  const home = await mkCanonicalTempDir("council-proc-");
  await copyTemplateDb(path.join(home, "council.db"));
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

    it("returns true when only unsupported-extension files exist (so the scan reports them)", async () => {
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "ignored.bin"), "x");
      const proc = createDocumentProcessor({
        engine: new StubEngine(),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      // `.bin` is not in supportedFormats. Historically this returned
      // false (nothing to index) and the file vanished from every
      // surface. It now returns true so chat startup runs the scan and
      // reports the unsupported file (Task T2).
      expect(await proc.needsProcessing("alice", dir)).toBe(true);
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

    it("threads config.maxFileSizeBytes through to extractDocument, rejecting oversize files", async () => {
      // Wire-through test: when the processor is configured with a
      // `maxFileSizeBytes` ceiling, a file exceeding the ceiling must
      // be reported as failed (extractor.ts raises oversize-file). If
      // the ceiling is NOT threaded through, extractor.ts falls back
      // to its 50 MiB default and the small ceiling has no effect.
      const dir = await makeDocsDir(env, "alice");
      // 200-byte file with a 100-byte ceiling => oversize.
      await fs.writeFile(path.join(dir, "big.md"), "a".repeat(200));
      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: { ...CONFIG, maxFileSizeBytes: 100 },
      });
      const progress: { filename: string; status: string; error?: string }[] = [];
      const result = await proc.process("alice", dir, (p) => {
        progress.push({ filename: p.filename, status: p.status, error: p.error });
      });
      expect(result.filesFailed).toBe(1);
      expect(result.filesProcessed).toBe(0);
      const failed = progress.find((p) => p.status === "failed");
      expect(failed?.error ?? "").toMatch(/oversize|exceeds|limit/i);
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

    it("passes confinementRoot to extractDocument so symlink escapes are blocked (cross-platform, #452)", async () => {
      // OS-agnostic confinement guard. The real-symlink test above skips
      // on unprivileged Windows, leaving confinement unverified there.
      // Spying on extractDocument proves the processor always confines
      // every extraction to the (canonical) docs root — so any symlink
      // resolving outside is rejected by the extractor — without needing
      // symlink privileges. The docs dir is created canonical, so the
      // forwarded confinementRoot must equal docsPath exactly.
      const dir = await makeDocsDir(env, "alice");
      await fs.writeFile(path.join(dir, "good.md"), "good body");
      const spy = vi.spyOn(extractorModule, "extractDocument");
      try {
        const engine = new StubEngine([VALID_PROFILE_JSON]);
        const proc = createDocumentProcessor({
          engine,
          documentRepo: env.docRepo,
          profileRepo: env.profileRepo,
          indexer: env.indexer,
          config: CONFIG,
        });
        await proc.process("alice", dir);
        expect(spy).toHaveBeenCalled();
        for (const call of spy.mock.calls) {
          const opts = call[1] as { confinementRoot?: string } | undefined;
          expect(opts?.confinementRoot).toBe(dir);
        }
      } finally {
        spy.mockRestore();
      }
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

    it("does NOT reconcile-as-deleted a tracked file whose lstat throws transiently (#342)", async () => {
      // Sentinel re-review #2: per-file `lstat` failures (EBUSY/EACCES
      // races, transient permissions) used to drop the path from the
      // detector entirely. `DocumentProcessor.process()` builds its
      // `seenPaths` set and any tracked file not in it is marked
      // removed + pruned from the FTS index — so a transient stat
      // failure would silently destroy persisted expert_documents
      // state for a file that still exists on disk. The detector now
      // reports such files in `unknownStateFiles` and the processor
      // must include that bucket in `seenPaths` (alongside
      // newFiles/modifiedFiles/unchangedFiles/rejectedFiles).
      const dir = await makeDocsDir(env, "alice");
      const fileA = path.join(dir, "a.md");
      const fileB = path.join(dir, "b.md");
      await fs.writeFile(fileA, "alpha body alpha");
      await fs.writeFile(fileB, "beta body beta");

      // First run: both indexed and tracked.
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

      // Second run: inject a transient lstat failure for fileB ONLY.
      // The real fileB still exists on disk — the failure simulates an
      // EBUSY/EACCES race. The processor must NOT mark fileB removed.
      const realLstat = fs.lstat;
      const fileBCanonical = await fs.realpath(fileB);
      const procWithFault = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
        _detectorLstatOverride: async (p: string) => {
          if (path.resolve(p) === fileBCanonical) {
            const err: NodeJS.ErrnoException = new Error("EBUSY: simulated");
            err.code = "EBUSY";
            throw err;
          }
          return realLstat(p);
        },
      });
      const second = await procWithFault.process("alice", dir);
      expect(second.filesRemoved).toBe(0);

      // fileB must still be tracked in expert_documents.
      const remaining = await env.docRepo.getChecksumMap("alice");
      expect(remaining.has(fileBCanonical)).toBe(true);
      expect(remaining.has(fileA)).toBe(true);
    });

    it("propagates the extractor's fd-bound modifiedAt into the analyzer prompt (issue #376)", async () => {
      // Two files with very different mtimes — older one should receive
      // a markedly smaller recency weight than the newer one in the
      // analyzer prompt. This proves the processor consumes mtime from
      // the extractor (which reads it via fh.stat on the bound fd)
      // rather than via a separate post-extraction fs.stat that could
      // observe a different mtime.
      const dir = await makeDocsDir(env, "alice");
      const recent = path.join(dir, "recent.md");
      const old = path.join(dir, "old.md");
      await fs.writeFile(recent, "recent body");
      await fs.writeFile(old, "old body");
      // Move `old` 30 half-lives back so its weight rounds to ~0.
      const halfLifeMs = CONFIG.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
      const oldTime = new Date(Date.now() - 30 * halfLifeMs);
      await fs.utimes(old, oldTime, oldTime);

      const engine = new StubEngine([VALID_PROFILE_JSON]);
      const proc = createDocumentProcessor({
        engine,
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const result = await proc.process("alice", dir);
      expect(result.filesProcessed).toBe(2);
      expect(result.filesFailed).toBe(0);

      const prompt = engine.sends[0]?.prompt ?? "";
      // Both files render their own weight header; recent's weight
      // should be near 1.00, old's should be ~0.00. The mere presence
      // of differentiated Weight tags proves modifiedAt propagated
      // through the pipeline.
      expect(prompt).toMatch(/--- recent\.md --- \[Weight: 1\.00\]/);
      expect(prompt).toMatch(/--- old\.md --- \[Weight: 0\.00\]/);
    });

    it("uses the extractor's fd-bound modifiedAt, not a post-extraction path stat, for the analyzer weight (regression #445)", async () => {
      // #445: the #376 test above only proves *some* mtime propagates — it
      // cannot distinguish the extractor's fd-bound `modifiedAt` (captured
      // via `fh.stat` DURING extraction) from a hypothetical
      // post-extraction `fs.stat(path)`, because the file's mtime is stable
      // throughout that test. Force the two to diverge: mutate the file's
      // on-disk mtime to ~30 half-lives ago from INSIDE `indexer.index` —
      // which the pipeline invokes strictly AFTER `extractDocument` returns
      // but BEFORE the analyzer builds its prompt. A path-based re-stat
      // would then observe the aged mtime (Weight 0.00); the fd-bound value
      // must still reflect the original ~now mtime (Weight 1.00).
      const dir = await makeDocsDir(env, "alice");
      const probe = path.join(dir, "probe.md");
      await fs.writeFile(probe, "probe body probe body");

      const halfLifeMs = CONFIG.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
      const agedTime = new Date(Date.now() - 30 * halfLifeMs);

      // Capture the real indexer BEFORE spying so the mock can delegate.
      const realIndex = env.indexer.index.bind(env.indexer);
      const indexSpy = vi
        .spyOn(env.indexer, "index")
        .mockImplementation(async (opts) => {
          // Runs after extraction captured modifiedAt, before analysis —
          // the exact TOCTOU window #445 guards against.
          await fs.utimes(probe, agedTime, agedTime);
          await realIndex(opts);
        });

      try {
        const engine = new StubEngine([VALID_PROFILE_JSON]);
        const proc = createDocumentProcessor({
          engine,
          documentRepo: env.docRepo,
          profileRepo: env.profileRepo,
          indexer: env.indexer,
          config: CONFIG,
        });
        const result = await proc.process("alice", dir);
        expect(result.filesProcessed).toBe(1);
        expect(indexSpy).toHaveBeenCalledTimes(1);

        const prompt = engine.sends[0]?.prompt ?? "";
        // fd-bound mtime (≈ now) → Weight 1.00. A post-extraction path
        // stat would observe the aged mtime and render 0.00 instead.
        expect(prompt).toMatch(/--- probe\.md --- \[Weight: 1\.00\]/);
        expect(prompt).not.toMatch(/--- probe\.md --- \[Weight: 0\.00\]/);
      } finally {
        indexSpy.mockRestore();
      }
    });

    // ───────────────────────────────────────────────────────────────
    // #447: rejectedFiles are added to seenPaths so a tracked file
    // whose on-disk form turns into a confinement-violating symlink
    // is NOT silently pruned. The detector reports it in
    // `rejectedFiles`; the processor must preserve persisted state.
    // ───────────────────────────────────────────────────────────────
    it("does NOT prune a tracked file that becomes a confinement-rejected symlink (#447)", async () => {
      const dir = await makeDocsDir(env, "alice");
      const fileA = path.join(dir, "a.md");
      const fileB = path.join(dir, "b.md");
      await fs.writeFile(fileA, "alpha body alpha");
      await fs.writeFile(fileB, "beta body beta");

      // First run: index + track both files.
      const proc = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON, VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const first = await proc.process("alice", dir);
      expect(first.filesProcessed).toBe(2);

      // Replace fileB with a symlink that escapes the docs root. The
      // detector's confinement check rejects the file, so the path
      // lands in `rejectedFiles` (NOT in newFiles/modifiedFiles/
      // unchangedFiles). Without the seenPaths fix, the reconciliation
      // pass would treat the missing-from-scan path as deleted and
      // mark the persisted row removed.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-outside-"));
      const escapeTarget = path.join(outside, "secret.md");
      await fs.writeFile(escapeTarget, "secret");
      await fs.rm(fileB);
      try {
        await fs.symlink(escapeTarget, fileB);
      } catch {
        await fs.rm(outside, { recursive: true, force: true });
        return; // symlinks unsupported on this host — skip
      }

      const proc2 = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      const second = await proc2.process("alice", dir);
      await fs.rm(outside, { recursive: true, force: true });

      // The rejected path must NOT have been reconciled-as-deleted.
      expect(second.filesRemoved).toBe(0);
      const remaining = await env.docRepo.getChecksumMap("alice");
      expect(remaining.has(fileB)).toBe(true);
      expect(remaining.has(fileA)).toBe(true);
      // And the rejection must be surfaced in the failed counter so
      // the user still sees it.
      expect(second.filesFailed).toBeGreaterThanOrEqual(1);
    });

    // ───────────────────────────────────────────────────────────────
    // #448: process() forwards `onWarning` to the detector so per-
    // file transient failures (lstat EBUSY/EACCES) reach the caller.
    // ───────────────────────────────────────────────────────────────
    it("propagates onWarning to the detector for per-file transient failures (#448)", async () => {
      const dir = await makeDocsDir(env, "alice");
      const fileA = path.join(dir, "a.md");
      const fileB = path.join(dir, "b.md");
      await fs.writeFile(fileA, "alpha body alpha");
      await fs.writeFile(fileB, "beta body beta");

      // Seed: both files tracked.
      const proc = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON, VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
      });
      await proc.process("alice", dir);

      // Second run: inject a transient lstat failure for fileB. The
      // detector emits a warning string through its `onWarning` sink
      // (see detector.ts:onWarning). Without the processor wiring
      // (#448), `process()` ignores its `onWarning` parameter and the
      // callback never fires.
      const realLstat = fs.lstat;
      const fileBCanonical = await fs.realpath(fileB);
      const procWithFault = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: CONFIG,
        _detectorLstatOverride: async (p: string) => {
          if (path.resolve(p) === fileBCanonical) {
            const err: NodeJS.ErrnoException = new Error("EBUSY: simulated");
            err.code = "EBUSY";
            throw err;
          }
          return realLstat(p);
        },
      });

      const warnings: string[] = [];
      await procWithFault.process("alice", dir, undefined, (msg) => warnings.push(msg));

      expect(warnings.length).toBeGreaterThan(0);
      // The detector formats per-file warnings mentioning the path.
      expect(warnings.some((w) => w.includes(fileBCanonical) || w.includes("b.md"))).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// AI-fallback config wiring (T-AIPIPE).
//
// `.xyz` has no native extractor, so a `.xyz` file listed in
// supportedFormats reaches extractDocument with no resolved extractor —
// the only path on which the AI fallback runs. These tests prove the
// processor threads `config.aiFallback` into extractDocument and handles
// the three result shapes (off → failed/unsupported, auto → indexed +
// AI-extracted, ask → needs-review + NOT indexed).
// ─────────────────────────────────────────────────────────────────────
describe("createDocumentProcessor — AI fallback wiring (T-AIPIPE)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  const AI_FORMATS: readonly string[] = [".md", ".txt", ".xyz"];

  async function ftsCount(slug: string): Promise<number> {
    const rows = await sql<{
      c: number;
    }>`SELECT COUNT(*) AS c FROM document_index WHERE source_slug = ${slug}`.execute(env.db);
    return rows.rows[0]?.c ?? 0;
  }

  it("off mode: an unsupported file (no native extractor) is reported as failed and NOT indexed", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.xyz"), "plain text body for xyz", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "off", allowedExtensions: [] },
      },
    });
    const result = await proc.process("alice", dir);

    expect(result.filesProcessed).toBe(0);
    expect(result.filesFailed).toBe(1);
    expect(result.filesNeedingReview).toBe(0);
    const f = result.files.find((x) => x.filename === "notes.xyz");
    expect(f?.status).toBe("failed");
    expect(f?.errorKind).toBe("unsupported-format");
    expect(await ftsCount("alice")).toBe(0);
  });

  it("auto mode: indexes the AI-fallback content and represents it as AI-extracted", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.xyz"), "plain text body for xyz", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "auto", allowedExtensions: [] },
      },
    });
    const result = await proc.process("alice", dir);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(result.filesNeedingReview).toBe(0);
    const f = result.files.find((x) => x.filename === "notes.xyz");
    expect(f?.status).toBe("indexed");
    expect(f?.aiExtracted).toBe(true);
    // Indexed into FTS and tracked as processed.
    expect(await ftsCount("alice")).toBe(1);
    const tracked = await env.docRepo.findByExpert("alice");
    expect(tracked.length).toBe(1);
    expect(tracked[0]?.status).toBe("processed");
  });

  it("ask mode: records needs-review, does NOT index into FTS, and does NOT track the file", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.xyz"), "plain text body for xyz", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "ask", allowedExtensions: [] },
      },
    });
    const result = await proc.process("alice", dir);

    expect(result.filesProcessed).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.filesNeedingReview).toBe(1);
    const f = result.files.find((x) => x.filename === "notes.xyz");
    expect(f?.status).toBe("needs-review");
    // NOT indexed into FTS, NOT tracked (so it keeps surfacing for review).
    expect(await ftsCount("alice")).toBe(0);
    const tracked = await env.docRepo.findByExpert("alice");
    expect(tracked.length).toBe(0);
  });

  it("ask mode emits a needs-review progress event for the file", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.xyz"), "plain text body for xyz", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "ask", allowedExtensions: [] },
      },
    });
    const progress: { filename: string; status: string }[] = [];
    await proc.process("alice", dir, (p) => {
      progress.push({ filename: p.filename, status: p.status });
    });
    expect(progress.some((p) => p.filename === "notes.xyz" && p.status === "needs-review")).toBe(
      true,
    );
  });

  it("auto→ask→modify: evicts the prior FTS row + repo entry instead of leaving stale content searchable (regression #1019)", async () => {
    const dir = await makeDocsDir(env, "alice");
    const filePath = path.join(dir, "notes.xyz");
    await fs.writeFile(filePath, "original AI body for xyz", "utf-8");

    // 1) auto mode indexes the AI-fallback file and tracks it.
    const auto = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "auto", allowedExtensions: [] },
      },
    });
    await auto.process("alice", dir);
    expect(await ftsCount("alice")).toBe(1);

    // 2) operator switches aiExtraction to `ask`, then edits the file.
    await fs.writeFile(filePath, "EDITED ai body for xyz with new content", "utf-8");
    const ask = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "ask", allowedExtensions: [] },
      },
    });
    const result = await ask.process("alice", dir);

    expect(result.filesNeedingReview).toBe(1);
    // Pre-edit content must NOT linger in FTS while UX reports needs-review.
    expect(await ftsCount("alice")).toBe(0);
    const tracked = await env.docRepo.findByExpert("alice");
    expect(tracked.find((d) => d.filePath === filePath)?.status).toBe("removed");
  });

  it("does NOT query findByPath for an ask-mode file that was never tracked (avoids N+1 #1831)", async () => {
    // #1831: the prior code called documentRepo.findByPath for EVERY
    // ask-mode file, even ones never tracked — an N+1 query. Only a
    // previously-tracked path can carry a prior FTS row, so gate the lookup
    // behind the in-memory `known` checksum map. A fresh (untracked)
    // ask-mode file must skip findByPath entirely.
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.xyz"), "plain text body", "utf-8");
    const findByPathSpy = vi.spyOn(env.docRepo, "findByPath");
    try {
      const proc = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: {
          supportedFormats: AI_FORMATS,
          recencyHalfLifeDays: 90,
          aiFallback: { mode: "ask", allowedExtensions: [] },
        },
      });
      const result = await proc.process("alice", dir);
      // Held for review, but never tracked → zero per-file lookups.
      expect(result.filesNeedingReview).toBe(1);
      expect(findByPathSpy).not.toHaveBeenCalled();
    } finally {
      findByPathSpy.mockRestore();
    }
  });

  it("isolates an FTS-eviction failure during ask-mode review: file stays needs-review, not failed (#1831)", async () => {
    // #1831: evicting a prior FTS row while downgrading a tracked file to
    // needs-review must be error-isolated. A transient indexer/repo failure
    // must NOT bubble up and misclassify the file as a hard extraction
    // failure — the file stays needs-review and the error surfaces via
    // onWarning.
    const dir = await makeDocsDir(env, "alice");
    const filePath = path.join(dir, "notes.xyz");
    await fs.writeFile(filePath, "original ai body", "utf-8");

    // 1) auto indexes + tracks the file so a prior FTS row exists.
    const auto = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "auto", allowedExtensions: [] },
      },
    });
    await auto.process("alice", dir);
    expect(await ftsCount("alice")).toBe(1);

    // 2) switch to ask + edit; make the FTS eviction throw.
    await fs.writeFile(filePath, "edited ai body with new content", "utf-8");
    const removeSpy = vi
      .spyOn(env.indexer, "remove")
      .mockRejectedValue(new Error("simulated FTS eviction failure"));
    const warnings: string[] = [];
    try {
      const ask = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: {
          supportedFormats: AI_FORMATS,
          recencyHalfLifeDays: 90,
          aiFallback: { mode: "ask", allowedExtensions: [] },
        },
      });
      const result = await ask.process("alice", dir, undefined, (m) => warnings.push(m));

      // Error isolated: held for review, NOT counted as a hard failure.
      expect(result.filesNeedingReview).toBe(1);
      expect(result.filesFailed).toBe(0);
      const f = result.files.find((x) => x.filename === "notes.xyz");
      expect(f?.status).toBe("needs-review");
      // The eviction was attempted and its failure surfaced (not swallowed).
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(warnings.some((w) => w.includes("notes.xyz"))).toBe(true);
      expect(warnings.some((w) => w.includes("simulated FTS eviction failure"))).toBe(true);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("sanitizes the ask-mode eviction-failure warning against terminal control-sequence injection (#1831)", async () => {
    // Adversarial-byte oracle: the eviction-failure warning embeds
    // untrusted text (filename + underlying error message) and routes to a
    // terminal log sink, so it MUST collapse to a single sanitized line —
    // no C0/C1 controls, DEL, bidi overrides, or line/paragraph separators
    // that could spoof output or inject ANSI escape sequences.
    const dir = await makeDocsDir(env, "alice");
    const filePath = path.join(dir, "notes.xyz");
    await fs.writeFile(filePath, "original ai body", "utf-8");

    const auto = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: AI_FORMATS,
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "auto", allowedExtensions: [] },
      },
    });
    await auto.process("alice", dir);

    await fs.writeFile(filePath, "edited ai body with new content", "utf-8");
    // TAB, C0, ANSI CSI, C1 (CSI/OSC/NEL), DEL, bidi override + isolates,
    // CR/LF, and U+2028/U+2029 — the full hostile-byte battery.
    const adversarial =
      "boom\tTAB\u0001C0\u001B[31mANSI\u009BC1\u009D\u0085\u007FDEL" +
      "\u202Ebidi\u2066iso\u2069\r\nCRLF\u2028LS\u2029PS";
    const removeSpy = vi
      .spyOn(env.indexer, "remove")
      .mockRejectedValue(new Error(adversarial));
    const warnings: string[] = [];
    try {
      const ask = createDocumentProcessor({
        engine: new StubEngine([VALID_PROFILE_JSON]),
        documentRepo: env.docRepo,
        profileRepo: env.profileRepo,
        indexer: env.indexer,
        config: {
          supportedFormats: AI_FORMATS,
          recencyHalfLifeDays: 90,
          aiFallback: { mode: "ask", allowedExtensions: [] },
        },
      });
      await ask.process("alice", dir, undefined, (m) => warnings.push(m));

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const evictionWarning = warnings.find((w) => w.includes("notes.xyz")) ?? "";
      expect(evictionWarning).toContain("notes.xyz");
      // Single-line: no raw CR/LF/TAB or U+2028/U+2029 survive.
      expect(evictionWarning).not.toMatch(/[\r\n\t\u2028\u2029]/);
      // No C0/C1 controls, DEL, or bidi override/isolate codepoints.
      expect(evictionWarning).not.toMatch(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
      );
      // Benign visible text is preserved (sanitized, not dropped wholesale).
      expect(evictionWarning).toContain("boom");
      expect(evictionWarning).toContain("ANSI");
    } finally {
      removeSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Unsupported-extension files (Task T2).
//
// A file whose extension is NOT in `supportedFormats` (e.g. `.png`,
// `.zip`) is rejected by the detector before extraction and historically
// dropped silently. The processor must surface it as a distinct
// `unsupported` outcome: counted in `filesUnsupported` AND `filesFailed`,
// present in `files` with `errorKind: "unsupported-format"`, and reported
// via the progress stream so `expert train` reflects it.
// ─────────────────────────────────────────────────────────────────────
describe("createDocumentProcessor — unsupported-extension files (T2)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("classifies an unsupported-extension file as a distinct unsupported outcome", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.md"), "# Notes\nhello\n", "utf-8");
    await fs.writeFile(path.join(dir, "screenshot.png"), "binary-ish", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: CONFIG,
    });

    const result = await proc.process("alice", dir);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesUnsupported).toBe(1);
    // Unsupported files are also counted as failures so existing
    // failure-driven surfaces (e.g. expert train aggregate) reflect them.
    expect(result.filesFailed).toBe(1);
    const png = result.files.find((x) => x.filename === "screenshot.png");
    expect(png?.status).toBe("failed");
    expect(png?.errorKind).toBe("unsupported-format");
    expect(png?.extension).toBe(".png");
  });

  it("reports an unsupported-only folder instead of silently dropping it", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "diagram.png"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: CONFIG,
    });

    const result = await proc.process("alice", dir);

    expect(result.filesUnsupported).toBe(1);
    expect(result.filesFailed).toBe(1);
    const png = result.files.find((x) => x.filename === "diagram.png");
    expect(png?.status).toBe("failed");
    expect(png?.errorKind).toBe("unsupported-format");
  });

  it("accounts for every file dropped in (counts add up, no disappearance)", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.md"), "# Notes\nhello\n", "utf-8");
    await fs.writeFile(path.join(dir, "screenshot.png"), "x", "utf-8");
    await fs.writeFile(path.join(dir, "archive.zip"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: CONFIG,
    });

    const result = await proc.process("alice", dir);

    // Every file on disk appears in the per-file detail list — none vanish.
    expect(result.files.map((f) => f.filename).sort()).toEqual([
      "archive.zip",
      "notes.md",
      "screenshot.png",
    ]);
    expect(result.filesUnsupported).toBe(2);
    // indexed + skipped + failed + needs-review covers all discovered files.
    const accounted =
      result.filesProcessed + result.filesSkipped + result.filesFailed + result.filesNeedingReview;
    expect(accounted).toBe(3);
  });

  it("emits a failed progress event for the unsupported file (surfaces in expert train)", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "screenshot.png"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: CONFIG,
    });

    const progress: { filename: string; status: string; error?: string }[] = [];
    await proc.process("alice", dir, (p) => {
      progress.push({
        filename: p.filename,
        status: p.status,
        ...(p.error !== undefined ? { error: p.error } : {}),
      });
    });

    const evt = progress.find((p) => p.filename === "screenshot.png");
    expect(evt?.status).toBe("failed");
    expect(evt?.error).toMatch(/unsupported/i);
  });

  it("retains the FTS index + tracking for a previously-indexed file that later becomes unsupported (index-lifecycle #1039)", async () => {
    // #1039: when an operator removes an extension from supportedFormats, a
    // previously-indexed file becomes UNSUPPORTED on re-scan. The processor
    // adds unsupported paths to `seenPaths` so the prune pass SKIPS them —
    // retention, NOT deletion, is the intended index-lifecycle. Ratify it:
    // the prior FTS row + tracking survive (still retrievable) and the file
    // is surfaced as an `unsupported` outcome, never silently pruned.
    const dir = await makeDocsDir(env, "alice");
    const filePath = path.join(dir, "memo.md");
    await fs.writeFile(filePath, "memo body memo body", "utf-8");

    async function ftsCount(): Promise<number> {
      const rows = await sql<{
        c: number;
      }>`SELECT COUNT(*) AS c FROM document_index WHERE source_slug = 'alice'`.execute(env.db);
      return rows.rows[0]?.c ?? 0;
    }

    // 1) index + track under a config that supports .md.
    const supported = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: CONFIG,
    });
    const first = await supported.process("alice", dir);
    expect(first.filesProcessed).toBe(1);
    expect(await ftsCount()).toBe(1);

    // 2) operator drops .md from supportedFormats, then re-scans.
    const dropped = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: { supportedFormats: [".txt"] as readonly string[], recencyHalfLifeDays: 90 },
    });
    const second = await dropped.process("alice", dir);

    // Surfaced as unsupported, but NOT pruned: prior state is retained.
    expect(second.filesRemoved).toBe(0);
    expect(second.filesUnsupported).toBe(1);
    const memo = second.files.find((f) => f.filename === "memo.md");
    expect(memo?.status).toBe("failed");
    expect(memo?.errorKind).toBe("unsupported-format");
    // Retention: FTS row + tracking survive (retrievable), not removed.
    expect(await ftsCount()).toBe(1);
    const tracked = await env.docRepo.getChecksumMap("alice");
    expect(tracked.has(filePath)).toBe(true);
  });

  it("counts filesUnsupported for BOTH the detector-filtered and extraction-classified paths (#1039)", async () => {
    // #1039: `filesUnsupported` aggregates two distinct paths — (a) an
    // extension absent from supportedFormats, filtered up front by the
    // detector, and (b) a SUPPORTED extension that resolves to no native
    // extractor (AI fallback off) and is classified `unsupported-format`
    // during extraction. Both increment the same counter in one scan.
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "image.png"), "not-really-an-image", "utf-8");
    await fs.writeFile(path.join(dir, "notes.xyz"), "plain text body", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      // .png absent → detector-filtered path; .xyz present but has no
      // native extractor → extraction-classified path. No AI fallback.
      config: {
        supportedFormats: [".md", ".txt", ".xyz"] as readonly string[],
        recencyHalfLifeDays: 90,
      },
    });
    const result = await proc.process("alice", dir);

    // Both paths increment the SAME counter → 2, and both are also
    // reflected in filesFailed (the existing dual-counting contract).
    expect(result.filesUnsupported).toBe(2);
    expect(result.filesFailed).toBe(2);
    const png = result.files.find((f) => f.filename === "image.png");
    const xyz = result.files.find((f) => f.filename === "notes.xyz");
    expect(png?.errorKind).toBe("unsupported-format");
    expect(xyz?.errorKind).toBe("unsupported-format");
  });
});

// ─────────────────────────────────────────────────────────────────────
// `ask` mode surfaces eligible unsupported-extension files for review (T4).
//
// A file whose extension is NOT in `supportedFormats` (e.g. `.key`) is
// dropped by the detector before extraction — so the AI fallback inside
// extractDocument never runs on it. With `aiExtraction: ask`, such an
// eligible (non-blocklisted) file must NOT be reported as a dead-end
// unsupported failure: it must surface as an "awaiting AI-extraction
// review" / needs-review outcome, WITHOUT being indexed or tracked. With
// `aiExtraction: off`, the same file stays unsupported (T2 regression
// guard). Blocklisted extensions (e.g. `.png`) stay unsupported even in
// ask mode.
// ─────────────────────────────────────────────────────────────────────
describe("createDocumentProcessor — ask-mode review for unsupported extensions (T4)", () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  async function ftsCount(slug: string): Promise<number> {
    const rows = await sql<{
      c: number;
    }>`SELECT COUNT(*) AS c FROM document_index WHERE source_slug = ${slug}`.execute(env.db);
    return rows.rows[0]?.c ?? 0;
  }

  it("ask mode: an eligible unsupported-extension file becomes needs-review, NOT indexed or tracked", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "deck.key"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: [".md", ".txt"],
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "ask", allowedExtensions: [] },
      },
    });

    const result = await proc.process("alice", dir);

    expect(result.filesNeedingReview).toBe(1);
    // Held for review — NOT counted as failed/unsupported.
    expect(result.filesFailed).toBe(0);
    expect(result.filesUnsupported).toBe(0);
    const f = result.files.find((x) => x.filename === "deck.key");
    expect(f?.status).toBe("needs-review");
    expect(f?.errorKind).toBeUndefined();
    // Never indexed into FTS, never tracked (so it keeps surfacing).
    expect(await ftsCount("alice")).toBe(0);
    const tracked = await env.docRepo.findByExpert("alice");
    expect(tracked.length).toBe(0);
  });

  it("ask mode emits a needs-review progress event for the unsupported-extension file", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "deck.key"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: [".md", ".txt"],
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "ask", allowedExtensions: [] },
      },
    });

    const progress: { filename: string; status: string }[] = [];
    await proc.process("alice", dir, (p) => {
      progress.push({ filename: p.filename, status: p.status });
    });
    expect(progress.some((p) => p.filename === "deck.key" && p.status === "needs-review")).toBe(
      true,
    );
  });

  it("off mode: the same unsupported-extension file stays unsupported (T2 regression guard)", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "deck.key"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: [".md", ".txt"],
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "off", allowedExtensions: [] },
      },
    });

    const result = await proc.process("alice", dir);

    expect(result.filesNeedingReview).toBe(0);
    expect(result.filesUnsupported).toBe(1);
    expect(result.filesFailed).toBe(1);
    const f = result.files.find((x) => x.filename === "deck.key");
    expect(f?.status).toBe("failed");
    expect(f?.errorKind).toBe("unsupported-format");
  });

  it("ask mode: a blocklisted extension (.png) stays unsupported, an eligible one (.key) becomes needs-review; counts add up", async () => {
    const dir = await makeDocsDir(env, "alice");
    await fs.writeFile(path.join(dir, "notes.md"), "# Notes\nhi\n", "utf-8");
    await fs.writeFile(path.join(dir, "deck.key"), "x", "utf-8");
    await fs.writeFile(path.join(dir, "shot.png"), "x", "utf-8");
    const proc = createDocumentProcessor({
      engine: new StubEngine([VALID_PROFILE_JSON]),
      documentRepo: env.docRepo,
      profileRepo: env.profileRepo,
      indexer: env.indexer,
      config: {
        supportedFormats: [".md", ".txt"],
        recencyHalfLifeDays: 90,
        aiFallback: { mode: "ask", allowedExtensions: [] },
      },
    });

    const result = await proc.process("alice", dir);

    expect(result.filesProcessed).toBe(1); // notes.md
    expect(result.filesNeedingReview).toBe(1); // deck.key
    expect(result.filesUnsupported).toBe(1); // shot.png (blocklisted)
    expect(result.filesFailed).toBe(1); // shot.png
    const key = result.files.find((x) => x.filename === "deck.key");
    expect(key?.status).toBe("needs-review");
    const png = result.files.find((x) => x.filename === "shot.png");
    expect(png?.status).toBe("failed");
    expect(png?.errorKind).toBe("unsupported-format");
    // Every discovered file is accounted for — none disappear.
    const accounted =
      result.filesProcessed + result.filesSkipped + result.filesFailed + result.filesNeedingReview;
    expect(accounted).toBe(3);
  });
});

/**
 * MockEngine-based pipeline integration tests.
 *
 * Unlike the unit suites under tests/unit/, these tests exercise full
 * end-to-end flows that cross multiple layers (file YAML <-> DB <->
 * domain code <-> MockEngine). They use only:
 *   - in-memory libsql DBs (`createDatabase(":memory:")`)
 *   - per-test temp directories (data home, docs folder)
 *   - MockEngine for any LLM call (deterministic, offline)
 *
 * Coverage:
 *   1. Expert lifecycle  — FileExpertLibrary CRUD + on-disk YAML round-trip
 *   2. Panel  lifecycle  — PanelLibraryRepository wiring to expert library
 *   3. Chat   flow       — ChatRepository session/turn persistence + resume
 *   4. Persona pipeline  — DocumentProcessor extracts profile, indexes FTS5
 *
 * No CLI/IO surface is exercised here — that's the job of the
 * `council *` command tests under tests/unit/cli/. These tests
 * deliberately stay one layer below the CLI to keep the
 * integration scope focused on the data + engine plumbing.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { sql } from "kysely";
import * as yaml from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileExpertLibrary } from "../../src/core/expert-library.js";
import {
  type ExpertDefinition,
  ExpertDefinitionSchema,
} from "../../src/core/expert.js";
import { createDocumentIndexer } from "../../src/core/documents/indexer.js";
import { createDocumentProcessor } from "../../src/core/documents/processor.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import { MockEngine } from "../../src/engine/mock/mock-engine.js";
import { type CouncilDatabase, createDatabase } from "../../src/memory/db.js";
import { ChatRepository } from "../../src/memory/repositories/chat-repository.js";
import { DocumentRepository } from "../../src/memory/repositories/document-repository.js";
import { PanelLibraryRepository } from "../../src/memory/repositories/panel-library-repo.js";
import { ProfileRepository } from "../../src/memory/repositories/profile-repository.js";
import { mkCanonicalTempDir } from "../helpers/tmp.js";

// ─────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────

interface PipelineEnv {
  readonly dataHome: string;
  readonly db: CouncilDatabase;
}

async function makeEnv(): Promise<PipelineEnv> {
  const dataHome = await mkCanonicalTempDir("council-pipeline-");
  const db = await createDatabase(":memory:");
  return { dataHome, db };
}

async function teardown(env: PipelineEnv): Promise<void> {
  await env.db.destroy().catch(() => undefined);
  for (let i = 0; i < 5; i += 1) {
    try {
      await fs.rm(env.dataHome, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function expertDef(slug: string, displayName: string): ExpertDefinition {
  return ExpertDefinitionSchema.parse({
    slug,
    displayName,
    role: `Test ${slug}`,
    expertise: {
      weightedEvidence: ["case studies"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Pragmatic, evidence-driven.",
    kind: "generic",
  });
}

const VALID_PROFILE_JSON = JSON.stringify({
  communicationStyle: "Crisp, opinionated, ships first.",
  decisionPatterns: ["bias-to-action", "ship-incrementally"],
  biases: ["recency"],
  vocabulary: ["ship", "iterate", "evidence"],
  epistemicStance: "Empirical Bayesian; updates fast on evidence.",
});

// ─────────────────────────────────────────────────────────────────────
// 1. Expert lifecycle pipeline
// ─────────────────────────────────────────────────────────────────────

describe("integration: expert lifecycle (FileExpertLibrary)", () => {
  let env: PipelineEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("create -> writes YAML and persists; list returns it; delete removes both", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);
    const def = expertDef("cto", "Dahlia Renner (CTO)");

    await library.create(def);

    // YAML written on disk at <dataHome>/experts/<slug>.yaml.
    const yamlPath = path.join(env.dataHome, "experts", "cto.yaml");
    const onDisk = await fs.readFile(yamlPath, "utf-8");
    const reparsed = yaml.parse(onDisk) as ExpertDefinition;
    expect(reparsed.slug).toBe("cto");
    expect(reparsed.displayName).toBe("Dahlia Renner (CTO)");

    // DB row checksum matches what we wrote.
    const expectedChecksum = createHash("sha256").update(onDisk).digest("hex");
    const row = await env.db
      .selectFrom("expert_library")
      .select(["yaml_checksum", "kind", "display_name"])
      .where("slug", "=", "cto")
      .executeTakeFirstOrThrow();
    expect(row.yaml_checksum).toBe(expectedChecksum);
    expect(row.kind).toBe("generic");
    expect(row.display_name).toBe("Dahlia Renner (CTO)");

    // list() returns the parsed definition.
    const all = await library.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.slug).toBe("cto");

    // get() round-trips.
    const got = await library.get("cto");
    expect(got?.displayName).toBe("Dahlia Renner (CTO)");

    // delete() removes both YAML and DB row.
    await library.delete("cto", { force: false });
    await expect(fs.access(yamlPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await library.get("cto")).toBeNull();
    expect(await library.list()).toHaveLength(0);
  });

  it("rejects creating a duplicate slug", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);
    await library.create(expertDef("cto", "First CTO"));
    await expect(library.create(expertDef("cto", "Second CTO"))).rejects.toThrow(
      /already exists/i,
    );
  });

  it("blocks delete when the expert is a member of a panel (without force)", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);
    const panelRepo = new PanelLibraryRepository(env.db);
    await library.create(expertDef("cto", "CTO"));
    await library.create(expertDef("sre", "SRE"));

    // Create panel that references both experts.
    await panelRepo.create({
      name: "ops-review",
      description: "Operational review panel",
      yamlPath: path.join(env.dataHome, "panels", "ops-review.yaml"),
      yamlChecksum: "deadbeef",
    });
    await panelRepo.setMembers("ops-review", ["cto", "sre"]);

    // panelsFor() returns the membership the library can see.
    expect(await library.panelsFor("cto")).toEqual(["ops-review"]);

    // Delete without force is refused with a helpful message.
    await expect(
      library.delete("cto", { force: false }),
    ).rejects.toThrow(/member of panels/i);

    // Forced delete reports the affected panel and removes the row.
    const result = await library.delete("cto", { force: true });
    expect(result.affectedPanels).toEqual(["ops-review"]);
    expect(await library.get("cto")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Panel lifecycle pipeline
// ─────────────────────────────────────────────────────────────────────

describe("integration: panel lifecycle (PanelLibraryRepository + experts)", () => {
  let env: PipelineEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("creates a panel YAML referencing library experts; getMembers preserves order; resolvePanel hydrates definitions", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);
    const panelRepo = new PanelLibraryRepository(env.db);

    await library.create(expertDef("cto", "CTO"));
    await library.create(expertDef("sre", "SRE"));
    await library.create(expertDef("pm", "Product Manager"));

    // Author a slug-referencing panel YAML the way `council panel create`
    // would: members are slug strings, not inline definitions.
    const panelYaml = yaml.stringify({
      name: "arch-review",
      description: "Architecture review panel",
      defaults: { mode: "freeform" as const },
      experts: ["cto", "sre", "pm"],
    });
    const panelsDir = path.join(env.dataHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    const yamlPath = path.join(panelsDir, "arch-review.yaml");
    await fs.writeFile(yamlPath, panelYaml, "utf-8");
    const checksum = createHash("sha256").update(panelYaml).digest("hex");

    await panelRepo.create({
      name: "arch-review",
      description: "Architecture review panel",
      yamlPath,
      yamlChecksum: checksum,
    });
    await panelRepo.setMembers("arch-review", ["cto", "sre", "pm"]);

    // YAML on disk parses back to the expected slug list (string refs only).
    const onDisk = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as {
      experts: readonly unknown[];
    };
    expect(onDisk.experts).toEqual(["cto", "sre", "pm"]);

    // DB membership preserves position.
    const members = await panelRepo.getMembers("arch-review");
    expect(members).toEqual(["cto", "sre", "pm"]);

    // resolvePanel pulls full definitions back from the file library.
    const { resolved, missing } = await library.resolvePanel(members);
    expect(missing).toEqual([]);
    expect(resolved.map((e) => e.slug)).toEqual(["cto", "sre", "pm"]);
    expect(resolved.map((e) => e.displayName)).toEqual([
      "CTO",
      "SRE",
      "Product Manager",
    ]);
  });

  it("resolvePanel reports missing expert slugs without throwing", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);
    await library.create(expertDef("cto", "CTO"));

    const { resolved, missing } = await library.resolvePanel(["cto", "ghost"]);
    expect(resolved.map((e) => e.slug)).toEqual(["cto"]);
    expect(missing).toEqual(["ghost"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Chat flow pipeline
// ─────────────────────────────────────────────────────────────────────

describe("integration: chat flow (ChatRepository persistence + resume)", () => {
  let env: PipelineEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("creates a session, persists alternating turns from MockEngine, and resumes via findActiveSession", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);
    await library.create(expertDef("cto", "CTO"));

    const engine = new MockEngine({
      responses: { "expert-cto": "Ship the MVP. Add observability later." },
    });
    await engine.start();
    try {
      await engine.addExpert({
        id: "expert-cto",
        slug: "cto",
        displayName: "CTO",
        model: "mock-model",
        systemMessage: "You are the CTO.",
      });

      const chats = new ChatRepository(env.db);
      const session = await chats.createSession({
        targetType: "expert",
        targetSlug: "cto",
      });
      expect(session.status).toBe("active");
      expect(session.targetSlug).toBe("cto");

      // Drive a 2-round conversation through MockEngine and persist
      // every turn — the contract that runExpertChat enforces.
      const userPrompts = [
        "What's the biggest risk of skipping observability?",
        "How would you mitigate it post-launch?",
      ];
      for (const prompt of userPrompts) {
        await chats.addTurn({
          chatId: session.id,
          role: "user",
          content: prompt,
        });

        let assistantText = "";
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;
        for await (const evt of engine.send({
          expertId: "expert-cto",
          prompt,
        })) {
          if (evt.kind === "message.delta") assistantText += evt.text;
          else if (evt.kind === "message.complete") {
            tokensIn = evt.response.tokensIn;
            tokensOut = evt.response.tokensOut;
          }
        }
        expect(assistantText.length).toBeGreaterThan(0);

        await chats.addTurn({
          chatId: session.id,
          role: "expert",
          expertSlug: "cto",
          content: assistantText,
          tokensIn,
          tokensOut,
        });
      }

      // Persistence: 4 turns total (2 user + 2 expert), monotonic seq.
      const turns = await chats.getTurns(session.id);
      expect(turns).toHaveLength(4);
      expect(turns.map((t) => t.seq)).toEqual([1, 2, 3, 4]);
      expect(turns.map((t) => t.role)).toEqual([
        "user",
        "expert",
        "user",
        "expert",
      ]);
      expect(turns[1]?.expertSlug).toBe("cto");
      expect(await chats.getTurnCount(session.id)).toBe(4);
      expect(await chats.getLatestSeq(session.id)).toBe(4);

      // Resume: the same target's most-recent active session is found.
      const resumed = await chats.findActiveSession("expert", "cto");
      expect(resumed?.id).toBe(session.id);

      // Archiving removes it from the active-resume lookup.
      await chats.archiveSession(session.id);
      expect(await chats.findActiveSession("expert", "cto")).toBeUndefined();
    } finally {
      await engine.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Persona document processing pipeline
// ─────────────────────────────────────────────────────────────────────

describe("integration: persona document processing (DocumentProcessor + FTS5)", () => {
  let env: PipelineEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("processes a persona expert's docs folder end-to-end: extract -> index in FTS5 -> profile upserted", async () => {
    const library = new FileExpertLibrary(env.dataHome, env.db);

    // Persona expert in the library.
    const personaDef: ExpertDefinition = ExpertDefinitionSchema.parse({
      slug: "alex",
      displayName: "Alex",
      role: "Engineering mentor",
      expertise: {
        weightedEvidence: ["code review notes", "1:1 transcripts"],
        referenceCases: [],
        notExpertIn: [],
      },
      epistemicStance: "Empirical, hands-on.",
      kind: "persona",
      personaDescription: "VP of Engineering I report to",
    });
    await library.create(personaDef);

    // Test .md file in the persona's docs folder.
    const docsDir = path.join(env.dataHome, "experts", "alex", "docs");
    await fs.mkdir(docsDir, { recursive: true });
    const memoPath = path.join(docsDir, "weekly-review-notes.md");
    const memoBody = [
      "# Weekly review notes",
      "",
      "We should ship the MVP and iterate on observability after launch.",
      "Evidence beats opinion. Always show the data.",
    ].join("\n");
    await fs.writeFile(memoPath, memoBody, "utf-8");

    // The persona pipeline calls `analyzeDocuments()` under the hood,
    // which registers a transient analyzer expert with a freshly-minted
    // ULID and immediately sends it a meta-prompt. Because the id is
    // generated inside analyzeDocuments() we cannot pre-seed
    // MockEngine.responses by key. Wrap the engine so its `send()`
    // always streams a valid analyzer JSON, while delegating lifecycle
    // calls to the underlying MockEngine so the analyzer's transient
    // registration goes through the real contract.
    const innerEngine = new MockEngine();
    await innerEngine.start();
    const engine = wrapAnalyzerResponse(innerEngine, VALID_PROFILE_JSON);

    try {
      const indexer = createDocumentIndexer(env.db);
      const processor = createDocumentProcessor({
        engine,
        documentRepo: new DocumentRepository(env.db),
        profileRepo: new ProfileRepository(env.db),
        indexer,
        config: {
          supportedFormats: [".md", ".txt"],
          recencyHalfLifeDays: 90,
        },
      });

      // Pre-check: detector finds the new file.
      expect(await processor.needsProcessing("alex", docsDir)).toBe(true);

      const progress: { filename: string; status: string }[] = [];
      const result = await processor.process("alex", docsDir, (p) =>
        progress.push({ filename: p.filename, status: p.status }),
      );

      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);
      expect(result.profileUpdated).toBe(true);
      expect(result.profileError).toBeNull();
      expect(progress).toEqual([
        { filename: "weekly-review-notes.md", status: "success" },
      ]);

      // Document indexed in FTS5 — searchable by the words in the memo.
      const ftsRows = await sql<{
        source_type: string;
        source_slug: string;
        file_path: string;
      }>`
        SELECT source_type, source_slug, file_path
        FROM document_index
        WHERE document_index MATCH 'observability'
      `.execute(env.db);
      expect(ftsRows.rows).toHaveLength(1);
      expect(ftsRows.rows[0]?.source_type).toBe("expert");
      expect(ftsRows.rows[0]?.source_slug).toBe("alex");
      expect(ftsRows.rows[0]?.file_path).toBe(memoPath);

      // Document tracked in expert_documents with status=processed.
      const docs = await new DocumentRepository(env.db).findByExpert("alex");
      expect(docs).toHaveLength(1);
      expect(docs[0]?.status).toBe("processed");
      expect(docs[0]?.filename).toBe("weekly-review-notes.md");
      expect(docs[0]?.wordCount).toBeGreaterThan(0);

      // Profile extracted and persisted.
      const profile = await new ProfileRepository(env.db).findBySlug("alex");
      expect(profile).not.toBeNull();
      expect(profile?.communicationStyle).toBe(
        "Crisp, opinionated, ships first.",
      );
      expect(profile?.decisionPatterns).toContain("ship-incrementally");
      expect(profile?.documentCount).toBe(1);
      expect(profile?.totalWords).toBeGreaterThan(0);

      // Idempotency: re-running with no doc changes is a no-op.
      expect(await processor.needsProcessing("alex", docsDir)).toBe(false);
    } finally {
      await innerEngine.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns a CouncilEngine-shaped wrapper around `inner` whose `send()`
 * always streams the supplied `text` followed by `message.complete`.
 *
 * Used to drive the persona-pipeline test: DocumentProcessor calls
 * analyzeDocuments(), which registers a transient ULID-id analyzer
 * expert and immediately sends it the meta-prompt. Because the id is
 * generated inside analyzeDocuments() we cannot pre-seed
 * MockEngine.responses by key. This wrapper short-circuits the response
 * stream regardless of expert id, while delegating lifecycle calls
 * (start/stop/addExpert/removeExpert/listModels) to the underlying
 * MockEngine so the analyzer's transient registration still goes
 * through the real contract.
 */
function wrapAnalyzerResponse(
  inner: MockEngine,
  text: string,
): CouncilEngine {
  return {
    start: () => inner.start(),
    stop: () => inner.stop(),
    addExpert: (spec) => inner.addExpert(spec),
    removeExpert: (id) => inner.removeExpert(id),
    listModels: () => inner.listModels(),
    send: ({ expertId }) =>
      (async function* () {
        yield { kind: "message.delta" as const, expertId, text };
        yield {
          kind: "message.complete" as const,
          expertId,
          response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
        };
      })(),
  };
}

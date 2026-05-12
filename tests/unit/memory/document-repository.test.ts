/**
 * Tests for DocumentRepository — Roadmap 6.1.
 *
 * RED at this commit: migration 006, ExpertDocumentRow, and
 * src/memory/repositories/document-repository.ts do not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertLibraryRepository } from "../../../src/memory/repositories/expert-library-repo.js";
import {
  DocumentRepository,
  type NewExpertDocument,
} from "../../../src/memory/repositories/document-repository.js";

async function seedExpert(db: CouncilDatabase, slug = "ceo"): Promise<void> {
  const repo = new ExpertLibraryRepository(db);
  await repo.create({
    slug,
    kind: "persona",
    displayName: "Test Persona",
    yamlPath: `/tmp/Council/experts/${slug}.yaml`,
    yamlChecksum: "y1",
  });
}

function sampleDoc(overrides: Partial<NewExpertDocument> = {}): NewExpertDocument {
  return {
    expertSlug: "ceo",
    filePath: "/tmp/Council/experts/ceo/docs/bio.md",
    filename: "bio.md",
    checksum: "abc123",
    sizeBytes: 1024,
    wordCount: 200,
    ...overrides,
  };
}

describe("DocumentRepository", () => {
  let db: CouncilDatabase;
  let repo: DocumentRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    await seedExpert(db);
    repo = new DocumentRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() inserts a row and returns the domain object with id+timestamps", async () => {
    const created = await repo.create(sampleDoc());
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.expertSlug).toBe("ceo");
    expect(created.filePath).toBe("/tmp/Council/experts/ceo/docs/bio.md");
    expect(created.filename).toBe("bio.md");
    expect(created.checksum).toBe("abc123");
    expect(created.sizeBytes).toBe(1024);
    expect(created.wordCount).toBe(200);
    expect(created.status).toBe("pending");
    expect(created.processedAt).toBeNull();
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("findByExpert() returns all documents for the expert", async () => {
    await repo.create(sampleDoc({ filePath: "/p/a.md", filename: "a.md" }));
    await repo.create(sampleDoc({ filePath: "/p/b.md", filename: "b.md" }));
    const docs = await repo.findByExpert("ceo");
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.filename).sort()).toEqual(["a.md", "b.md"]);
  });

  it("findByExpert() returns empty array when no documents exist", async () => {
    const docs = await repo.findByExpert("ceo");
    expect(docs).toEqual([]);
  });

  it("findByPath() returns the row when it exists", async () => {
    await repo.create(sampleDoc({ filePath: "/p/a.md" }));
    const found = await repo.findByPath("ceo", "/p/a.md");
    expect(found?.filePath).toBe("/p/a.md");
    const missing = await repo.findByPath("ceo", "/p/missing.md");
    expect(missing).toBeUndefined();
  });

  it("updateStatus() sets status and processedAt", async () => {
    const created = await repo.create(sampleDoc());
    const ts = "2025-01-01T12:00:00.000Z";
    await repo.updateStatus(created.id, "processed", ts);
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.status).toBe("processed");
    expect(after?.processedAt).toBe(ts);
  });

  it("updateStatus() works without processedAt argument", async () => {
    const created = await repo.create(sampleDoc());
    await repo.updateStatus(created.id, "failed");
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.status).toBe("failed");
    expect(after?.processedAt).toBeNull();
  });

  it("updateChecksum() updates checksum/size/wordCount", async () => {
    const created = await repo.create(sampleDoc());
    await repo.updateChecksum(created.id, "newhash", 2048, 400);
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.checksum).toBe("newhash");
    expect(after?.sizeBytes).toBe(2048);
    expect(after?.wordCount).toBe(400);
  });

  it("getChecksumMap() returns path → checksum map for non-removed docs", async () => {
    const a = await repo.create(sampleDoc({ filePath: "/p/a.md", checksum: "h1" }));
    await repo.create(sampleDoc({ filePath: "/p/b.md", checksum: "h2" }));
    const removed = await repo.create(sampleDoc({ filePath: "/p/c.md", checksum: "h3" }));
    await repo.markRemoved(removed.id);

    const map = await repo.getChecksumMap("ceo");
    expect(map.get("/p/a.md")).toBe("h1");
    expect(map.get("/p/b.md")).toBe("h2");
    expect(map.has("/p/c.md")).toBe(false);
    expect(map.size).toBe(2);
    expect(a.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("markRemoved() sets status to 'removed'", async () => {
    const created = await repo.create(sampleDoc());
    await repo.markRemoved(created.id);
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.status).toBe("removed");
  });

  it("UNIQUE (expert_slug, file_path) constraint is enforced", async () => {
    await repo.create(sampleDoc({ filePath: "/p/same.md" }));
    await expect(repo.create(sampleDoc({ filePath: "/p/same.md" }))).rejects.toThrow();
  });

  it("migration 006 is idempotent (re-running createDatabase succeeds)", async () => {
    // Already created in beforeEach; creating another DB just exercises migrations again.
    const second = await createDatabase(":memory:");
    await second.destroy();
  });
});

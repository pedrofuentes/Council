/**
 * Tests for PanelDocumentRepository — Roadmap 6.7.
 *
 * Mirrors document-repository.test.ts but covers the panel-scoped
 * tables introduced by migration 009 (panel_linked_folders +
 * panel_documents). RED at this commit: migration 009, the row types,
 * and src/memory/repositories/panel-document-repo.ts do not exist yet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../src/memory/repositories/panel-library-repo.js";
import {
  PanelDocumentRepository,
  type NewPanelDocument,
} from "../../../src/memory/repositories/panel-document-repo.js";

async function seedPanel(db: CouncilDatabase, name = "arch-review"): Promise<void> {
  const repo = new PanelLibraryRepository(db);
  await repo.create({
    name,
    description: "Test panel",
    yamlPath: `/tmp/Council/panels/${name}.yaml`,
    yamlChecksum: "y1",
  });
}

function sampleDoc(overrides: Partial<NewPanelDocument> = {}): NewPanelDocument {
  return {
    panelName: "arch-review",
    source: "managed",
    filePath: "/tmp/Council/panels/arch-review/docs/spec.md",
    filename: "spec.md",
    checksum: "abc123",
    sizeBytes: 1024,
    wordCount: 200,
    ...overrides,
  };
}

describe("PanelDocumentRepository", () => {
  let db: CouncilDatabase;
  let repo: PanelDocumentRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    await seedPanel(db);
    repo = new PanelDocumentRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("linked folders", () => {
    it("addLinkedFolder() stores the path and getLinkedFolders() returns it", async () => {
      await repo.addLinkedFolder("arch-review", "/tmp/shared-specs");
      const folders = await repo.getLinkedFolders("arch-review");
      expect(folders).toEqual(["/tmp/shared-specs"]);
    });

    it("addLinkedFolder() is idempotent on (panel_name, folder_path)", async () => {
      await repo.addLinkedFolder("arch-review", "/tmp/shared-specs");
      await repo.addLinkedFolder("arch-review", "/tmp/shared-specs");
      const folders = await repo.getLinkedFolders("arch-review");
      expect(folders).toEqual(["/tmp/shared-specs"]);
    });

    it("removeLinkedFolder() deletes the row", async () => {
      await repo.addLinkedFolder("arch-review", "/tmp/a");
      await repo.addLinkedFolder("arch-review", "/tmp/b");
      await repo.removeLinkedFolder("arch-review", "/tmp/a");
      const folders = await repo.getLinkedFolders("arch-review");
      expect(folders).toEqual(["/tmp/b"]);
    });

    it("getLinkedFolders() returns empty when none are linked", async () => {
      const folders = await repo.getLinkedFolders("arch-review");
      expect(folders).toEqual([]);
    });

    it("deleting the parent panel cascades to panel_linked_folders", async () => {
      await repo.addLinkedFolder("arch-review", "/tmp/x");
      const panels = new PanelLibraryRepository(db);
      await panels.delete("arch-review");
      const folders = await repo.getLinkedFolders("arch-review");
      expect(folders).toEqual([]);
    });
  });

  describe("documents", () => {
    it("trackDocument() inserts a managed row", async () => {
      await repo.trackDocument(sampleDoc());
      const docs = await repo.listDocuments("arch-review");
      expect(docs).toHaveLength(1);
      expect(docs[0]?.panelName).toBe("arch-review");
      expect(docs[0]?.source).toBe("managed");
      expect(docs[0]?.filePath).toBe("/tmp/Council/panels/arch-review/docs/spec.md");
      expect(docs[0]?.filename).toBe("spec.md");
      expect(docs[0]?.checksum).toBe("abc123");
      expect(docs[0]?.sizeBytes).toBe(1024);
      expect(docs[0]?.wordCount).toBe(200);
      expect(docs[0]?.status).toBe("pending");
      expect(docs[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(docs[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("trackDocument() upserts on (panel_name, file_path) updating checksum/size/words", async () => {
      await repo.trackDocument(sampleDoc({ checksum: "h1", sizeBytes: 100, wordCount: 10 }));
      await repo.trackDocument(sampleDoc({ checksum: "h2", sizeBytes: 200, wordCount: 20 }));
      const docs = await repo.listDocuments("arch-review");
      expect(docs).toHaveLength(1);
      expect(docs[0]?.checksum).toBe("h2");
      expect(docs[0]?.sizeBytes).toBe(200);
      expect(docs[0]?.wordCount).toBe(20);
    });

    it("trackDocument() supports a 'linked' source", async () => {
      await repo.trackDocument(
        sampleDoc({
          source: "linked",
          filePath: "/tmp/shared-specs/api.md",
          filename: "api.md",
        }),
      );
      const docs = await repo.listDocuments("arch-review");
      expect(docs[0]?.source).toBe("linked");
    });

    it("getChecksumMap() returns path → checksum for the panel", async () => {
      await repo.trackDocument(sampleDoc({ filePath: "/p/a.md", checksum: "h1" }));
      await repo.trackDocument(sampleDoc({ filePath: "/p/b.md", checksum: "h2" }));
      const map = await repo.getChecksumMap("arch-review");
      expect(map.size).toBe(2);
      expect(map.get("/p/a.md")).toBe("h1");
      expect(map.get("/p/b.md")).toBe("h2");
    });

    it("listDocuments() returns empty when no documents exist", async () => {
      const docs = await repo.listDocuments("arch-review");
      expect(docs).toEqual([]);
    });

    it("listDocuments() is panel-scoped", async () => {
      await seedPanel(db, "other-panel");
      await repo.trackDocument(sampleDoc({ panelName: "arch-review", filePath: "/p/a.md" }));
      await repo.trackDocument(sampleDoc({ panelName: "other-panel", filePath: "/p/b.md" }));
      const arch = await repo.listDocuments("arch-review");
      const other = await repo.listDocuments("other-panel");
      expect(arch).toHaveLength(1);
      expect(other).toHaveLength(1);
      expect(arch[0]?.filePath).toBe("/p/a.md");
      expect(other[0]?.filePath).toBe("/p/b.md");
    });

    it("removeDocumentsUnderFolder() deletes every document whose path is inside the folder", async () => {
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/linked/a.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/linked/sub/b.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/other/c.md" }));

      await repo.removeDocumentsUnderFolder("arch-review", "/tmp/linked");

      const remaining = await repo.listDocuments("arch-review");
      expect(remaining.map((d) => d.filePath)).toEqual(["/tmp/other/c.md"]);
    });

    it("removeDocumentsUnderFolder() does not match sibling paths sharing a prefix", async () => {
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/linked/a.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/linked-other/b.md" }));

      await repo.removeDocumentsUnderFolder("arch-review", "/tmp/linked");

      const remaining = await repo.listDocuments("arch-review");
      expect(remaining.map((d) => d.filePath)).toEqual(["/tmp/linked-other/b.md"]);
    });

    it("removeDocumentsUnderFolder() handles Windows-style backslash paths", async () => {
      // Sentinel cycle 2 #7: backslash path coverage.
      await repo.trackDocument(sampleDoc({ filePath: "C:\\linked\\a.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "C:\\linked\\sub\\b.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "C:\\linked-other\\b.md" }));

      await repo.removeDocumentsUnderFolder("arch-review", "C:\\linked");

      const remaining = await repo.listDocuments("arch-review");
      expect(remaining.map((d) => d.filePath)).toEqual(["C:\\linked-other\\b.md"]);
    });

    it("removeDocumentsUnderFolder() does not match unrelated paths via SQL LIKE wildcards in folder name", async () => {
      // Sentinel cycle 2 #2: folder names containing % or _ must not
      // produce false-positive matches via unescaped LIKE patterns.
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/my%docs/a.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/myXXXdocs/b.md" }));
      await repo.trackDocument(sampleDoc({ filePath: "/tmp/myAdocs/c.md" }));

      await repo.removeDocumentsUnderFolder("arch-review", "/tmp/my%docs");

      const remaining = await repo.listDocuments("arch-review");
      const paths = remaining.map((d) => d.filePath).sort();
      expect(paths).toEqual(["/tmp/myAdocs/c.md", "/tmp/myXXXdocs/b.md"]);
    });

    it("deleting the parent panel cascades to panel_documents", async () => {
      await repo.trackDocument(sampleDoc());
      const panels = new PanelLibraryRepository(db);
      await panels.delete("arch-review");
      const docs = await repo.listDocuments("arch-review");
      expect(docs).toEqual([]);
    });
  });
});

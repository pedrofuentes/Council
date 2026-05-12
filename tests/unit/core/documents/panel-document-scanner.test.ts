/**
 * Tests for `scanAndIndexPanelDocuments` — Roadmap 6.7.
 *
 * RED at this commit: src/core/documents/panel-document-scanner.ts
 * does not exist yet.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { createDatabase, type CouncilDatabase } from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
import { PanelDocumentRepository } from "../../../../src/memory/repositories/panel-document-repo.js";
import { scanAndIndexPanelDocuments } from "../../../../src/core/documents/panel-document-scanner.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("scanAndIndexPanelDocuments", () => {
  let db: CouncilDatabase;
  let managedDir: string;
  let linkedDir: string;
  let cleanupDirs: string[] = [];

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    const panelRepo = new PanelLibraryRepository(db);
    await panelRepo.create({
      name: "arch-review",
      description: null,
      yamlPath: "/tmp/arch-review.yaml",
      yamlChecksum: "y1",
    });

    managedDir = await makeTempDir("council-managed-");
    linkedDir = await makeTempDir("council-linked-");
    cleanupDirs = [managedDir, linkedDir];

    await fs.writeFile(path.join(managedDir, "spec.md"), "# Spec\nhello world\n", "utf-8");
    await fs.writeFile(
      path.join(linkedDir, "external.md"),
      "# External\nlinked notes\n",
      "utf-8",
    );

    const docsRepo = new PanelDocumentRepository(db);
    await docsRepo.addLinkedFolder("arch-review", linkedDir);
  });

  afterEach(async () => {
    await db.destroy();
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("indexes new files from managed + linked folders into FTS5 under source_type='panel'", async () => {
    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    expect(result.indexed).toBe(2);
    expect(result.unchanged).toBe(0);

    const rows = await sql<{
      source_type: string;
      file_path: string;
    }>`SELECT source_type, file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.source_type).toBe("panel");
    }

    const docsRepo = new PanelDocumentRepository(db);
    const tracked = await docsRepo.listDocuments("arch-review");
    expect(tracked).toHaveLength(2);
    const sources = tracked.map((t) => t.source).sort();
    expect(sources).toEqual(["linked", "managed"]);
  });

  it("re-running with unchanged files is a no-op", async () => {
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    const second = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  it("re-indexes when a tracked file's checksum changes", async () => {
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    await fs.writeFile(path.join(managedDir, "spec.md"), "# Spec v2\nupdated\n", "utf-8");
    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.indexed).toBe(1);
    expect(result.unchanged).toBe(1);
  });

  it("missing managed folder is treated as empty (no throw)", async () => {
    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: path.join(managedDir, "does-not-exist"),
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    // linkedDir still contributes 1.
    expect(result.indexed).toBe(1);
  });
});

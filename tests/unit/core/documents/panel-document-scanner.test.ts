/**
 * Tests for `scanAndIndexPanelDocuments` — Roadmap 6.7.
 *
 * RED at this commit: src/core/documents/panel-document-scanner.ts
 * does not exist yet.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";

import { createDatabase, type CouncilDatabase } from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
import { PanelDocumentRepository } from "../../../../src/memory/repositories/panel-document-repo.js";
import {
  scanAndIndexPanelDocuments,
  formatAllFailedWarning,
} from "../../../../src/core/documents/panel-document-scanner.js";
import * as extractorModule from "../../../../src/core/documents/extractor.js";

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

  it("reports a folder-level failure when a folder scan throws", async () => {
    // Re-add a linked folder that does not exist on disk to provoke a
    // scan-time failure (the previous beforeEach folder still has its
    // files, so without this we cannot distinguish scan-error from no-op).
    const docsRepo = new PanelDocumentRepository(db);
    const ghost = path.join(linkedDir, "ghost-subdir");
    await docsRepo.addLinkedFolder("arch-review", ghost);

    // Pre-create a regular file at the path so detector treats it as
    // ENOTDIR (real scan error, not silently-empty ENOENT).
    await fs.writeFile(ghost, "not a directory", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.foldersFailed).toBeGreaterThanOrEqual(1);
  });

  it("refuses to follow symlinks inside a linked folder (path confinement)", async () => {
    // Sentinel cycle 2 finding #1 (CRITICAL): without confinementRoot
    // the panel scanner happily indexes whatever a symlink resolves
    // to, including files outside the linked folder.
    //
    // We create a directory junction/symlink at linkedDir/escape →
    // secretDir/. A file inside secretDir must NOT make it into the
    // panel's FTS index because the canonical path resolves outside
    // the confinement root.
    const secretDir = await makeTempDir("council-secret-");
    cleanupDirs.push(secretDir);
    await fs.writeFile(
      path.join(secretDir, "passwd.md"),
      "# Secret\ntop-secret-token-XYZZY\n",
      "utf-8",
    );

    const escapePath = path.join(linkedDir, "escape");
    let linkCreated = false;
    try {
      // junction works for directories without admin on Windows; on
      // POSIX `type` is ignored and a plain symlink is created.
      await fs.symlink(secretDir, escapePath, "junction");
      linkCreated = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOSYS") throw err;
      try {
        await fs.symlink(secretDir, escapePath);
        linkCreated = true;
      } catch {
        return;
      }
    }

    try {
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });

      const fts = await sql<{
        file_path: string;
        content: string;
      }>`SELECT file_path, content FROM document_index WHERE source_type = 'panel'`.execute(db);
      for (const row of fts.rows) {
        expect(row.content).not.toContain("top-secret-token-XYZZY");
      }
    } finally {
      // Explicitly remove the junction/symlink before afterEach
      // recursively removes linkedDir, so the recursive removal does
      // not traverse into secretDir (which would on Windows manifest
      // as a worker crash when racing with other tests' cleanup).
      if (linkCreated) {
        try {
          await fs.unlink(escapePath);
        } catch {
          /* best-effort */
        }
      }
    }
  });

  it("passes confinementRoot to extractDocument so symlink TOCTOU is blocked (issue #385)", async () => {
    const spy = vi.spyOn(extractorModule, "extractDocument");
    try {
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });
      expect(spy).toHaveBeenCalled();
      const canonicalManaged = await fs.realpath(managedDir);
      const canonicalLinked = await fs.realpath(linkedDir);
      for (const call of spy.mock.calls) {
        const opts = call[1] as { confinementRoot?: string } | undefined;
        expect(opts).toBeDefined();
        expect(opts?.confinementRoot).toBeDefined();
        const root = opts!.confinementRoot!;
        expect([canonicalManaged, canonicalLinked]).toContain(root);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("prunes documents that disappeared from disk (issue #386)", async () => {
    // First scan: both files indexed.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    const docsRepo = new PanelDocumentRepository(db);
    const beforeDocs = await docsRepo.listDocuments("arch-review");
    expect(beforeDocs.filter((d) => d.status !== "removed")).toHaveLength(2);

    // Delete one file from disk.
    await fs.unlink(path.join(linkedDir, "external.md"));

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.pruned).toBe(1);

    // panel_documents: the deleted file is marked removed.
    const after = await docsRepo.listDocuments("arch-review");
    const removed = after.filter((d) => d.status === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.filename).toBe("external.md");

    // document_index: the FTS entry for the deleted file is gone.
    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    const paths = fts.rows.map((r) => r.file_path);
    expect(paths).not.toContain(path.join(linkedDir, "external.md"));
  });
});

describe("formatAllFailedWarning", () => {
  it("returns a warning when every discovered document failed (issue #389)", () => {
    const msg = formatAllFailedWarning({
      indexed: 0,
      unchanged: 0,
      failed: 3,
      pruned: 0,
      foldersFailed: 0,
      managedFolderFailed: false,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("3");
    expect(msg).toMatch(/failed/i);
    expect(msg).toMatch(/permissions|formats/i);
  });

  it("returns null when at least one document was indexed", () => {
    expect(
      formatAllFailedWarning({
        indexed: 1,
        unchanged: 0,
        failed: 2,
        pruned: 0,
        foldersFailed: 0,
        managedFolderFailed: false,
      }),
    ).toBeNull();
  });

  it("returns null when at least one document was unchanged", () => {
    expect(
      formatAllFailedWarning({
        indexed: 0,
        unchanged: 5,
        failed: 1,
        pruned: 0,
        foldersFailed: 0,
        managedFolderFailed: false,
      }),
    ).toBeNull();
  });

  it("returns null when nothing failed", () => {
    expect(
      formatAllFailedWarning({
        indexed: 0,
        unchanged: 0,
        failed: 0,
        pruned: 0,
        foldersFailed: 0,
        managedFolderFailed: false,
      }),
    ).toBeNull();
  });
});

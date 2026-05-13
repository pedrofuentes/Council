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

  it("counts the file as failed when indexing succeeds but tracking throws (issue #393)", async () => {
    // Partial-failure scenario: indexer.index() commits the FTS row but
    // docsRepo.trackDocument() throws afterward. The scanner MUST surface
    // this as a `failed` count (not silently as `indexed`) so operators
    // can see that tracking metadata is out of sync with the FTS index.
    //
    // The fixture seeds two candidate files (spec.md + external.md) so
    // we can assert the exact failure count and prove both files were
    // attempted (issue #393 follow-up: not just >=1).
    const trackSpy = vi
      .spyOn(PanelDocumentRepository.prototype, "trackDocument")
      .mockRejectedValue(new Error("simulated tracking failure"));
    try {
      const result = await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });
      // Neither file was tracked, both should be counted as failed.
      expect(result.indexed).toBe(0);
      expect(result.failed).toBe(2);
      // The spy must have been called once per file before failing.
      expect(trackSpy).toHaveBeenCalledTimes(2);
    } finally {
      trackSpy.mockRestore();
    }
  });

  it("counts the file as failed when indexer.index throws but tracking would have succeeded (issue #393)", async () => {
    // Mirror of the above: drop the FTS table so indexer.index() throws,
    // and verify the scanner reports the file as failed and does NOT
    // persist a panel_documents row (otherwise we'd track docs that
    // aren't searchable).
    await sql`DROP TABLE document_index`.execute(db);

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.indexed).toBe(0);
    // Both candidate files (spec.md + external.md) must be attempted
    // and counted as failed.
    expect(result.failed).toBe(2);

    // No documents were tracked — only the pre-existing linked-folder
    // registration should remain.
    const docsRepo = new PanelDocumentRepository(db);
    const tracked = await docsRepo.listDocuments("arch-review");
    expect(tracked).toHaveLength(0);
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
      } catch (innerErr: unknown) {
        // Symlinks/junctions are unavailable in this environment
        // (typical: unprivileged Windows runner without Developer
        // Mode). Issue #392: instead of skipping silently or asserting
        // a broad platform predicate, narrow the assertion to the
        // specific filesystem error codes that indicate "this OS/user
        // cannot create symlinks", so a future regression that swaps
        // these for an unrelated error (e.g. ENOENT pointing at a bug
        // in the test fixture itself) will fail loudly.
        const innerCode = (innerErr as NodeJS.ErrnoException).code;
        expect(["EPERM", "EACCES", "ENOSYS", "UNKNOWN"]).toContain(innerCode);
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
        const root = opts?.confinementRoot;
        expect(root).toBeDefined();
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
  it("prunes managed-source documents when the managed folder is deleted (Sentinel #1)", async () => {
    // First scan: spec.md (managed) + external.md (linked) both indexed.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    // Remove the entire managed dir from disk (simulates user deleting it).
    await fs.rm(managedDir, { recursive: true, force: true });

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.pruned).toBe(1);

    const docsRepo = new PanelDocumentRepository(db);
    const after = await docsRepo.listDocuments("arch-review");
    const removedManaged = after.filter(
      (d) => d.status === "removed" && d.source === "managed",
    );
    expect(removedManaged).toHaveLength(1);

    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    const paths = fts.rows.map((r) => r.file_path);
    expect(paths).not.toContain(path.join(managedDir, "spec.md"));
  });

  it("does NOT markRemoved when indexer.remove fails (Sentinel #2)", async () => {
    // First indexing run.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    // Delete external.md so prune logic engages.
    await fs.unlink(path.join(linkedDir, "external.md"));

    // Force the FTS deletion to fail by dropping the document_index
    // table. The scanner must NOT mark the row removed in metadata if
    // the FTS deletion didn't succeed — otherwise the row appears
    // pruned while stale searchable content lingers.
    await sql`DROP TABLE document_index`.execute(db);

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.pruned).toBe(0);

    const docsRepo = new PanelDocumentRepository(db);
    const after = await docsRepo.listDocuments("arch-review");
    const external = after.find((d) => d.filename === "external.md");
    expect(external).toBeDefined();
    expect(external?.status).not.toBe("removed");
  });

  it("prunes managed docs even when the docs root reaches through a symlinked ancestor (Sentinel cycle-2)", async () => {
    // The managed root may be accessed via a path whose ancestor is a
    // symlink (e.g. /tmp → /private/tmp on macOS, or any user-set
    // mount alias). Tracked file paths are stored under the canonical
    // form. If the docs folder is later deleted, prune must still
    // recognise tracked paths as belonging to the (deleted) managed
    // root — otherwise stale managed FTS entries remain searchable.

    // Build: <tmp>/alias-parent/dir → real <tmp>/real-parent/dir
    // where alias-parent is a symlink to real-parent. Place the
    // managed docs dir UNDER the symlinked alias-parent.
    const realParent = await makeTempDir("council-real-parent-");
    const aliasHost = await makeTempDir("council-alias-host-");
    cleanupDirs.push(realParent, aliasHost);
    const aliasPath = path.join(aliasHost, "alias");

    let linkCreated = false;
    try {
      await fs.symlink(realParent, aliasPath, "junction");
      linkCreated = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOSYS") throw err;
      try {
        await fs.symlink(realParent, aliasPath);
        linkCreated = true;
      } catch {
        return; // platform doesn't allow symlinks — skip
      }
    }
    if (!linkCreated) return;

    try {
      const aliasManaged = path.join(aliasPath, "docs");
      await fs.mkdir(aliasManaged, { recursive: true });
      await fs.writeFile(path.join(aliasManaged, "alias-doc.md"), "# Alias\n", "utf-8");

      // First scan via the aliased path: tracked under realpath form.
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: aliasManaged,
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });

      // Sanity: tracked path is the canonical (real) form.
      const docsRepo = new PanelDocumentRepository(db);
      const beforeDocs = await docsRepo.listDocuments("arch-review");
      const aliasTracked = beforeDocs.find((d) => d.filename === "alias-doc.md");
      expect(aliasTracked).toBeDefined();
      const realManaged = path.join(await fs.realpath(realParent), "docs");
      expect(aliasTracked?.filePath.startsWith(realManaged)).toBe(true);

      // Delete the docs folder so the next scan sees ENOENT at the
      // managed root (via the aliased path).
      await fs.rm(path.join(realParent, "docs"), { recursive: true, force: true });

      const result = await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: aliasManaged, // missing — accessed through symlink
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });
      expect(result.pruned).toBeGreaterThanOrEqual(1);

      const after = await docsRepo.listDocuments("arch-review");
      const removed = after.find((d) => d.filename === "alias-doc.md");
      expect(removed?.status).toBe("removed");
    } finally {
      if (linkCreated) {
        try {
          await fs.unlink(aliasPath);
        } catch {
          /* best-effort */
        }
      }
    }
  });

  it("does not prune tracked docs under a linked folder whose scan failed (Sentinel #3)", async () => {
    // Seed: index spec.md (managed) and external.md (linked).
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    // Replace linkedDir with a file → readdir will fail with ENOTDIR,
    // triggering a folder-level failure in the next scan.
    await fs.rm(linkedDir, { recursive: true, force: true });
    await fs.writeFile(linkedDir, "now a file, not a dir", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.foldersFailed).toBeGreaterThanOrEqual(1);
    expect(result.pruned).toBe(0);

    const docsRepo = new PanelDocumentRepository(db);
    const after = await docsRepo.listDocuments("arch-review");
    const external = after.find((d) => d.filename === "external.md");
    expect(external?.status).not.toBe("removed");

    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    const paths = fts.rows.map((r) => r.file_path);
    expect(paths).toContain(path.join(linkedDir, "external.md"));
  });

  it("does not prune docs whose lstat throws transiently mid-scan (#342)", async () => {
    // Sentinel re-review: per-file `lstat` failures (EBUSY/EACCES races,
    // permissions transients) used to drop the path from `seenPaths`,
    // causing the panel-doc reconciliation loop to mark the file
    // `removed` and prune it from the FTS index. This is silent data
    // loss for content that still exists on disk. The detector now
    // reports such files in `unknownStateFiles`, and the panel scanner
    // must include that bucket in `seenPaths` so reconciliation
    // preserves them.
    //
    // Seed: index spec.md.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    const docsRepo = new PanelDocumentRepository(db);
    const before = await docsRepo.listDocuments("arch-review");
    const specRow = before.find((d) => d.filename === "spec.md");
    expect(specRow).toBeDefined();
    const specCanonical = await fs.realpath(path.join(managedDir, "spec.md"));

    // Use the `_detectorLstatOverride` test seam to inject a per-file
    // lstat failure for spec.md only. Cannot `vi.spyOn(fs, 'lstat')`
    // because `node:fs/promises` ESM namespace bindings are
    // non-configurable.
    const realLstat = fs.lstat;
    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
      _detectorLstatOverride: async (p: string) => {
        const resolved = path.resolve(p);
        if (resolved === specCanonical) {
          const err: NodeJS.ErrnoException = new Error("EBUSY: simulated busy");
          err.code = "EBUSY";
          throw err;
        }
        return realLstat(p);
      },
    });
    // The transient stat failure must NOT cause spec.md to be pruned.
    expect(result.pruned).toBe(0);

    const after = await docsRepo.listDocuments("arch-review");
    const spec = after.find((d) => d.filename === "spec.md");
    expect(spec?.status).not.toBe("removed");

    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    const paths = fts.rows.map((r) => r.file_path);
    expect(paths).toContain(specCanonical);
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

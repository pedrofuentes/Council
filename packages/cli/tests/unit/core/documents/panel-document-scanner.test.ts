/**
 * Tests for `scanAndIndexPanelDocuments` — Roadmap 6.7.
 *
 * RED at this commit: src/core/documents/panel-document-scanner.ts
 * does not exist yet.
 */
import * as fs from "node:fs/promises";
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
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";
import { mkCanonicalTempDir } from "../../../helpers/tmp.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkCanonicalTempDir(prefix);
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

  it("threads maxFileSizeBytes through to extractDocument, counting oversize files as failed", async () => {
    // Wire-through test: when the scanner is given a `maxFileSizeBytes`
    // ceiling, files exceeding it must be reported as `failed` (the
    // extractor raises oversize-file). Without the wire-through, the
    // extractor falls back to its 50 MiB default and the small ceiling
    // has no effect. The fixture seeds spec.md (~22 bytes) and
    // external.md (~28 bytes); a 10-byte ceiling rejects both.
    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
      maxFileSizeBytes: 10,
    });
    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(2);
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

  it("does not recreate panel_documents/FTS rows for a folder unlinked mid-scan (issue #424)", async () => {
    // Race regression: `panel docs unlink` and a concurrent
    // `panel-document-scanner` scan both touch the same panel_documents
    // + document_index rows. Before the fix, the scanner snapshotted
    // `getLinkedFolders` at start and then wrote new index/track rows
    // for files under that folder without re-checking link membership —
    // so a concurrent unlink would appear to succeed, but the rows
    // would be silently recreated by the still-running scan.
    //
    // We simulate the race deterministically by spying on
    // `extractDocument`: when the scanner calls it for the linked
    // file, we run the unlink-equivalent SQL (drop FTS row, drop
    // panel_documents rows, drop the linked-folder row) before
    // returning the extraction result. The scanner must observe the
    // unlink and skip writing the index + track for that file —
    // otherwise the unlink's effect is undone.
    //
    // The first scan populates the tracked state; rewriting the file
    // on disk forces the second scan to enter the "modified file"
    // branch (where the recreation race lives).
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    const linkedFile = path.join(linkedDir, "external.md");
    await fs.writeFile(linkedFile, "# External v2\nupdated body\n", "utf-8");

    const docsRepo = new PanelDocumentRepository(db);
    const indexer = createDocumentIndexer(db);

    // Simulate `council panel docs unlink --path linkedDir`. Mirrors
    // the operations in src/cli/commands/panel.ts buildDocsUnlinkCommand.
    async function simulateConcurrentUnlink(): Promise<void> {
      const tracked = await docsRepo.listDocuments("arch-review");
      await sql`BEGIN`.execute(db);
      try {
        for (const d of tracked) {
          if (
            d.filePath === linkedDir ||
            d.filePath.startsWith(linkedDir + path.sep) ||
            d.filePath.startsWith(linkedDir + "/") ||
            d.filePath.startsWith(linkedDir + "\\")
          ) {
            await indexer.remove(d.filePath);
          }
        }
        await docsRepo.removeDocumentsUnderFolder("arch-review", linkedDir);
        await docsRepo.removeLinkedFolder("arch-review", linkedDir);
        await sql`COMMIT`.execute(db);
      } catch (err) {
        await sql`ROLLBACK`.execute(db);
        throw err;
      }
    }

    let unlinkRan = false;
    const realExtract = extractorModule.extractDocument;
    const spy = vi
      .spyOn(extractorModule, "extractDocument")
      .mockImplementation(async (filePath, opts) => {
        const result = await realExtract(filePath, opts);
        // Trigger the unlink exactly once, when the scanner is about
        // to write the linked file. The managed file is allowed to
        // proceed normally so we can assert it remains unaffected.
        if (!unlinkRan && filePath === linkedFile) {
          unlinkRan = true;
          await simulateConcurrentUnlink();
        }
        return result;
      });

    try {
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });
    } finally {
      spy.mockRestore();
    }
    expect(unlinkRan).toBe(true);

    // The linked folder must remain unlinked.
    const linkedFolders = await docsRepo.getLinkedFolders("arch-review");
    expect(linkedFolders).not.toContain(linkedDir);

    // No active panel_documents rows under the unlinked folder. The
    // unlink path uses DELETE (not "removed" status), so both forms
    // must report zero rows under linkedDir.
    const allDocs = await docsRepo.listDocuments("arch-review");
    const underLinked = allDocs.filter(
      (d) =>
        d.filePath === linkedFile ||
        d.filePath.startsWith(linkedDir + path.sep) ||
        d.filePath.startsWith(linkedDir + "/") ||
        d.filePath.startsWith(linkedDir + "\\"),
    );
    expect(underLinked).toHaveLength(0);

    // No FTS rows for the unlinked file path.
    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    const paths = fts.rows.map((r) => r.file_path);
    expect(paths).not.toContain(linkedFile);
  });

  it("does not recreate rows when the unlink commits BETWEEN re-check and writes (issue #424 post-recheck window)", async () => {
    // Sentinel-cycle hardening: the prior regression test only fires
    // the unlink BEFORE the scanner reaches its membership re-check.
    // We must also prove the (re-check + index + track) sequence is
    // ATOMIC with respect to a concurrent unlink. We inject the
    // unlink at scan-start (`getLinkedFolders` is called once at the
    // top of the scan, well before per-file writes); the per-file
    // BEGIN IMMEDIATE block in the production fix must observe the
    // committed unlink and skip — recreating rows here would prove
    // the recheck/write atomicity is broken.
    //
    // Note: a true multi-connection cross-transaction race cannot be
    // simulated against a single in-memory libsql client. The
    // production code's `BEGIN IMMEDIATE` provides the multi-process
    // serialization guarantee documented at the call site; this test
    // covers the recheck/skip path under a different injection point
    // than the prior test for defense-in-depth coverage.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    const linkedFile = path.join(linkedDir, "external.md");
    await fs.writeFile(linkedFile, "# External v3\nrace check\n", "utf-8");

    const docsRepo = new PanelDocumentRepository(db);
    const indexer = createDocumentIndexer(db);

    async function simulateConcurrentUnlink(): Promise<void> {
      const tracked = await docsRepo.listDocuments("arch-review");
      await sql`BEGIN`.execute(db);
      try {
        for (const d of tracked) {
          if (
            d.filePath === linkedDir ||
            d.filePath.startsWith(linkedDir + path.sep) ||
            d.filePath.startsWith(linkedDir + "/") ||
            d.filePath.startsWith(linkedDir + "\\")
          ) {
            await indexer.remove(d.filePath);
          }
        }
        await docsRepo.removeDocumentsUnderFolder("arch-review", linkedDir);
        await docsRepo.removeLinkedFolder("arch-review", linkedDir);
        await sql`COMMIT`.execute(db);
      } catch (err) {
        await sql`ROLLBACK`.execute(db);
        throw err;
      }
    }

    const realGetLinkedFolders = PanelDocumentRepository.prototype.getLinkedFolders;
    let raced = false;
    const spy = vi
      .spyOn(PanelDocumentRepository.prototype, "getLinkedFolders")
      .mockImplementation(async function (
        this: PanelDocumentRepository,
        panelName: string,
      ) {
        const result = await realGetLinkedFolders.call(this, panelName);
        // Fire exactly once, on the scan-start `getLinkedFolders` —
        // before per-file writes have begun. The scanner must still
        // notice the unlink at its per-file recheck.
        if (!raced && result.includes(linkedDir)) {
          raced = true;
          await simulateConcurrentUnlink();
        }
        return result;
      });

    try {
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".html"],
      });
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);

    // Final state must reflect the unlink: no link row, no
    // panel_documents under linkedDir, no FTS rows for the file.
    const linkedFolders = await docsRepo.getLinkedFolders("arch-review");
    expect(linkedFolders).not.toContain(linkedDir);
    const allDocs = await docsRepo.listDocuments("arch-review");
    const underLinked = allDocs.filter((d) => d.filePath.startsWith(linkedDir));
    expect(underLinked).toHaveLength(0);
    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    expect(fts.rows.map((r) => r.file_path)).not.toContain(linkedFile);
  });

  // ─────────────────────────────────────────────────────────────────────
  // #447: scanner must add rejectedFiles to seenPaths so a tracked file
  // that turns into a confinement-violating symlink is NOT pruned.
  // Mirrors the DocumentProcessor behavior (processor.ts:seenPaths).
  // ─────────────────────────────────────────────────────────────────────
  it("does NOT prune a tracked file that becomes a confinement-rejected symlink (#447)", async () => {
    // First scan: spec.md (managed) + external.md (linked) both indexed.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    const docsRepo = new PanelDocumentRepository(db);
    const linkedFile = path.join(linkedDir, "external.md");
    const tracked = await docsRepo.listDocuments("arch-review");
    expect(tracked.map((d) => d.filename).sort()).toEqual([
      "external.md",
      "spec.md",
    ]);

    // Replace the tracked linked file with a symlink that escapes the
    // linkedDir confinement root. The detector rejects it (lands in
    // rejectedFiles, not unchanged/modified). Without the seenPaths
    // fix, reconciliation would mark the persisted row `removed` and
    // drop the FTS entry — silently destroying state for a file the
    // user has not deleted.
    const outside = await makeTempDir("council-outside-");
    cleanupDirs.push(outside);
    const escapeTarget = path.join(outside, "secret.md");
    await fs.writeFile(escapeTarget, "secret", "utf-8");
    await fs.unlink(linkedFile);
    try {
      await fs.symlink(escapeTarget, linkedFile);
    } catch {
      return; // symlinks not supported on this host
    }

    const result = await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });
    expect(result.pruned).toBe(0);

    const after = await docsRepo.listDocuments("arch-review");
    const externalRow = after.find((d) => d.filename === "external.md");
    expect(externalRow).toBeDefined();
    expect(externalRow?.status).not.toBe("removed");

    const fts = await sql<{
      file_path: string;
    }>`SELECT file_path FROM document_index WHERE source_type = 'panel'`.execute(db);
    expect(fts.rows.map((r) => r.file_path)).toContain(linkedFile);
  });

  // ─────────────────────────────────────────────────────────────────────
  // #528: when a linked folder is unlinked mid-scan, the per-file
  // BEGIN IMMEDIATE re-check fires the "skipped" branch. The scanner
  // must emit a progress event for that file instead of silently
  // continuing, so the caller can render an accurate per-file status.
  // ─────────────────────────────────────────────────────────────────────
  it("emits a progress event for a linked file whose folder is unlinked mid-scan (#528)", async () => {
    // Seed: both files tracked.
    await scanAndIndexPanelDocuments({
      panelName: "arch-review",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt", ".html"],
    });

    // Modify the linked file so the second scan enters the "modified
    // file" branch — that is where the re-check + skipped path lives.
    const linkedFile = path.join(linkedDir, "external.md");
    await fs.writeFile(linkedFile, "# External v2\nupdated body\n", "utf-8");

    const docsRepo = new PanelDocumentRepository(db);
    const indexer = createDocumentIndexer(db);

    async function simulateConcurrentUnlink(): Promise<void> {
      const trackedDocs = await docsRepo.listDocuments("arch-review");
      await sql`BEGIN`.execute(db);
      try {
        for (const d of trackedDocs) {
          if (
            d.filePath === linkedDir ||
            d.filePath.startsWith(linkedDir + path.sep) ||
            d.filePath.startsWith(linkedDir + "/") ||
            d.filePath.startsWith(linkedDir + "\\")
          ) {
            await indexer.remove(d.filePath);
          }
        }
        await docsRepo.removeDocumentsUnderFolder("arch-review", linkedDir);
        await docsRepo.removeLinkedFolder("arch-review", linkedDir);
        await sql`COMMIT`.execute(db);
      } catch (err) {
        await sql`ROLLBACK`.execute(db);
        throw err;
      }
    }

    let unlinkRan = false;
    const realExtract = extractorModule.extractDocument;
    const spy = vi
      .spyOn(extractorModule, "extractDocument")
      .mockImplementation(async (filePath, opts) => {
        const result = await realExtract(filePath, opts);
        if (!unlinkRan && filePath === linkedFile) {
          unlinkRan = true;
          await simulateConcurrentUnlink();
        }
        return result;
      });

    const progress: { filename: string; status: string }[] = [];
    try {
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".html"],
        onProgress: (e) => progress.push({ filename: e.filename, status: e.status }),
      });
    } finally {
      spy.mockRestore();
    }

    expect(unlinkRan).toBe(true);
    // The skipped-due-to-mid-scan-unlink event must surface to the
    // caller. Before the fix, `if (skipped) continue;` swallowed it.
    const externalEvents = progress.filter((p) => p.filename === "external.md");
    expect(externalEvents.length).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // AI-fallback config wiring (T-AIPIPE).
  //
  // `.xyz` has no native extractor, so a `.xyz` file in supportedFormats
  // reaches extractDocument with no resolved extractor — the only path
  // on which the AI fallback runs. The beforeEach seeds spec.md (managed)
  // and external.md (linked); each test adds a managed `.xyz` file.
  // ───────────────────────────────────────────────────────────────────
  describe("AI fallback wiring (T-AIPIPE)", () => {
    async function panelFtsCount(database: CouncilDatabase): Promise<number> {
      const rows = await sql<{
        c: number;
      }>`SELECT COUNT(*) AS c FROM document_index WHERE source_type = 'panel'`.execute(database);
      return rows.rows[0]?.c ?? 0;
    }

    it("off mode: a `.xyz` file with no native extractor is failed and NOT indexed", async () => {
      await fs.writeFile(path.join(managedDir, "notes.xyz"), "plain text for xyz", "utf-8");
      const result = await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".xyz"],
        aiFallback: { mode: "off", allowedExtensions: [] },
      });
      // spec.md + external.md indexed; notes.xyz failed.
      expect(result.indexed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.needsReview).toBe(0);
      const f = result.files.find((x) => x.filename === "notes.xyz");
      expect(f?.status).toBe("failed");
      expect(f?.errorKind).toBe("unsupported-format");
      expect(await panelFtsCount(db)).toBe(2);
    });

    it("auto mode: indexes the AI fallback content and marks it AI-extracted", async () => {
      await fs.writeFile(path.join(managedDir, "notes.xyz"), "plain text for xyz", "utf-8");
      const result = await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".xyz"],
        aiFallback: { mode: "auto", allowedExtensions: [] },
      });
      expect(result.indexed).toBe(3);
      expect(result.needsReview).toBe(0);
      const f = result.files.find((x) => x.filename === "notes.xyz");
      expect(f?.status).toBe("indexed");
      expect(f?.aiExtracted).toBe(true);
      // All three files are searchable.
      expect(await panelFtsCount(db)).toBe(3);
      const docsRepo = new PanelDocumentRepository(db);
      const tracked = await docsRepo.listDocuments("arch-review");
      expect(tracked).toHaveLength(3);
    });

    it("ask mode: records needs-review, does NOT index into FTS, and does NOT track", async () => {
      await fs.writeFile(path.join(managedDir, "notes.xyz"), "plain text for xyz", "utf-8");
      const result = await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".xyz"],
        aiFallback: { mode: "ask", allowedExtensions: [] },
      });
      // spec.md + external.md indexed; notes.xyz held for review.
      expect(result.indexed).toBe(2);
      expect(result.needsReview).toBe(1);
      const f = result.files.find((x) => x.filename === "notes.xyz");
      expect(f?.status).toBe("needs-review");
      // NOT searchable and NOT tracked.
      expect(await panelFtsCount(db)).toBe(2);
      const docsRepo = new PanelDocumentRepository(db);
      const tracked = await docsRepo.listDocuments("arch-review");
      expect(tracked).toHaveLength(2);
      expect(tracked.some((t) => t.filename === "notes.xyz")).toBe(false);
    });

    it("ask mode emits a needs-review progress event for the held file", async () => {
      await fs.writeFile(path.join(managedDir, "notes.xyz"), "plain text for xyz", "utf-8");
      const progress: { filename: string; status: string }[] = [];
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".xyz"],
        aiFallback: { mode: "ask", allowedExtensions: [] },
        onProgress: (p) => progress.push({ filename: p.filename, status: p.status }),
      });
      expect(
        progress.some((p) => p.filename === "notes.xyz" && p.status === "needs-review"),
      ).toBe(true);
    });

    it("auto→ask→modify: evicts the prior FTS row + repo entry instead of leaving stale content searchable (regression #1019)", async () => {
      const xyz = path.join(managedDir, "notes.xyz");
      await fs.writeFile(xyz, "original body for xyz", "utf-8");

      // 1) auto mode indexes spec.md + external.md + notes.xyz.
      await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".xyz"],
        aiFallback: { mode: "auto", allowedExtensions: [] },
      });
      expect(await panelFtsCount(db)).toBe(3);

      // 2) operator switches aiExtraction to `ask`, then edits notes.xyz.
      await fs.writeFile(xyz, "EDITED body for xyz with new content", "utf-8");
      const result = await scanAndIndexPanelDocuments({
        panelName: "arch-review",
        managedDocsDir: managedDir,
        db,
        supportedFormats: [".md", ".txt", ".xyz"],
        aiFallback: { mode: "ask", allowedExtensions: [] },
      });

      expect(result.needsReview).toBe(1);
      // Pre-edit content must NOT linger in FTS (spec.md + external.md remain).
      expect(await panelFtsCount(db)).toBe(2);
      const docsRepo = new PanelDocumentRepository(db);
      const tracked = await docsRepo.listDocuments("arch-review");
      expect(tracked.find((t) => t.filename === "notes.xyz")?.status).toBe("removed");
    });
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

// ─────────────────────────────────────────────────────────────────────
// Unsupported-extension files (Task T2).
//
// A file whose extension is NOT in `supportedFormats` (e.g. `.png`,
// `.zip`) is filtered by the detector before extraction and historically
// dropped silently from every surface. The panel scanner must surface it
// as a distinct `unsupported` outcome: counted in `unsupported` AND
// `failed` (so the chat-startup render gate fires), and present in
// `files` with `errorKind: "unsupported-format"` so `docs review` /
// `docs doctor` can enumerate it.
//
// This block uses its own panel with ONLY a managed folder (no linked
// folder) so the aggregate counts are unambiguous.
// ─────────────────────────────────────────────────────────────────────
describe("scanAndIndexPanelDocuments — unsupported-extension files (T2)", () => {
  let db: CouncilDatabase;
  let managedDir: string;
  let cleanupDirs: string[] = [];

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    const panelRepo = new PanelLibraryRepository(db);
    await panelRepo.create({
      name: "unsupported-panel",
      description: null,
      yamlPath: "/tmp/unsupported-panel.yaml",
      yamlChecksum: "u1",
    });
    managedDir = await makeTempDir("council-unsupported-");
    cleanupDirs = [managedDir];
  });

  afterEach(async () => {
    await db.destroy();
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces unsupported-extension files as a distinct unsupported outcome", async () => {
    await fs.writeFile(path.join(managedDir, "spec.md"), "# Spec\nhi\n", "utf-8");
    await fs.writeFile(path.join(managedDir, "screenshot.png"), "x", "utf-8");
    await fs.writeFile(path.join(managedDir, "archive.zip"), "x", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "unsupported-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
    });

    expect(result.indexed).toBe(1);
    expect(result.unsupported).toBe(2);
    // Counted as failures too, so the chat-startup render gate fires for
    // an otherwise unsupported-only scan.
    expect(result.failed).toBe(2);

    const png = result.files.find((f) => f.filename === "screenshot.png");
    expect(png?.status).toBe("failed");
    expect(png?.errorKind).toBe("unsupported-format");
    expect(png?.extension).toBe(".png");

    const zip = result.files.find((f) => f.filename === "archive.zip");
    expect(zip?.errorKind).toBe("unsupported-format");
    expect(zip?.extension).toBe(".zip");
  });

  it("does not silently drop unsupported files — every dropped file is accounted for", async () => {
    await fs.writeFile(path.join(managedDir, "spec.md"), "# Spec\nhi\n", "utf-8");
    await fs.writeFile(path.join(managedDir, "screenshot.png"), "x", "utf-8");
    await fs.writeFile(path.join(managedDir, "archive.zip"), "x", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "unsupported-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
    });

    expect(result.files.map((f) => f.filename).sort()).toEqual([
      "archive.zip",
      "screenshot.png",
      "spec.md",
    ]);
    // indexed + unchanged + failed accounts for every discovered file
    // (unsupported ⊆ failed).
    expect(result.indexed + result.unchanged + result.failed).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// `ask` mode surfaces eligible unsupported-extension files for review (T4).
//
// A file whose extension is NOT in `supportedFormats` (e.g. `.key`) is
// dropped by the detector before extraction, so the AI fallback never
// runs on it. With `aiExtraction: ask`, an eligible (non-blocklisted)
// file must surface as a `needs-review` ("awaiting AI-extraction review")
// outcome — NOT indexed, NOT tracked, NOT a dead-end unsupported failure.
// With `aiExtraction: off` the same file stays unsupported (T2 regression
// guard); a blocklisted extension (`.png`) stays unsupported even in ask
// mode.
// ─────────────────────────────────────────────────────────────────────
describe("scanAndIndexPanelDocuments — ask-mode review for unsupported extensions (T4)", () => {
  let db: CouncilDatabase;
  let managedDir: string;
  let cleanupDirs: string[] = [];

  async function panelFtsCount(database: CouncilDatabase): Promise<number> {
    const rows = await sql<{
      c: number;
    }>`SELECT COUNT(*) AS c FROM document_index WHERE source_type = 'panel'`.execute(database);
    return rows.rows[0]?.c ?? 0;
  }

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    const panelRepo = new PanelLibraryRepository(db);
    await panelRepo.create({
      name: "ask-panel",
      description: null,
      yamlPath: "/tmp/ask-panel.yaml",
      yamlChecksum: "a1",
    });
    managedDir = await makeTempDir("council-ask-review-");
    cleanupDirs = [managedDir];
  });

  afterEach(async () => {
    await db.destroy();
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ask mode: an eligible unsupported-extension file becomes needs-review, NOT indexed", async () => {
    await fs.writeFile(path.join(managedDir, "deck.key"), "x", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "ask", allowedExtensions: [] },
    });

    expect(result.needsReview).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.unsupported).toBe(0);
    const f = result.files.find((x) => x.filename === "deck.key");
    expect(f?.status).toBe("needs-review");
    expect(f?.errorKind).toBeUndefined();
    // Not searchable, not tracked.
    expect(await panelFtsCount(db)).toBe(0);
    const docsRepo = new PanelDocumentRepository(db);
    const tracked = await docsRepo.listDocuments("ask-panel");
    expect(tracked).toHaveLength(0);
  });

  it("ask mode emits a needs-review progress event for the unsupported-extension file", async () => {
    await fs.writeFile(path.join(managedDir, "deck.key"), "x", "utf-8");
    const progress: { filename: string; status: string }[] = [];

    await scanAndIndexPanelDocuments({
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "ask", allowedExtensions: [] },
      onProgress: (p) => progress.push({ filename: p.filename, status: p.status }),
    });

    expect(
      progress.some((p) => p.filename === "deck.key" && p.status === "needs-review"),
    ).toBe(true);
  });

  it("off mode: the same unsupported-extension file stays unsupported (T2 regression guard)", async () => {
    await fs.writeFile(path.join(managedDir, "deck.key"), "x", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "off", allowedExtensions: [] },
    });

    expect(result.needsReview).toBe(0);
    expect(result.unsupported).toBe(1);
    expect(result.failed).toBe(1);
    const f = result.files.find((x) => x.filename === "deck.key");
    expect(f?.status).toBe("failed");
    expect(f?.errorKind).toBe("unsupported-format");
  });

  it("ask mode: a blocklisted .png stays unsupported while an eligible .key becomes needs-review", async () => {
    await fs.writeFile(path.join(managedDir, "deck.key"), "x", "utf-8");
    await fs.writeFile(path.join(managedDir, "shot.png"), "x", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "ask", allowedExtensions: [] },
    });

    expect(result.needsReview).toBe(1);
    expect(result.unsupported).toBe(1);
    expect(result.failed).toBe(1);
    const key = result.files.find((x) => x.filename === "deck.key");
    expect(key?.status).toBe("needs-review");
    const png = result.files.find((x) => x.filename === "shot.png");
    expect(png?.status).toBe("failed");
    expect(png?.errorKind).toBe("unsupported-format");
    // Both files are accounted for in the per-file detail list.
    expect(result.files.map((f) => f.filename).sort()).toEqual([
      "deck.key",
      "shot.png",
    ]);
  });

  it("auto mode: an eligible unsupported-extension file is AI-extracted, indexed, and tracked", async () => {
    await fs.writeFile(path.join(managedDir, "deck.key"), "keynote outline", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "auto", allowedExtensions: [] },
    });

    // The detector drops `.key` (not in supportedFormats); in `auto`
    // mode the scanner must still AI-extract and index it — completing
    // the `docs extract` workflow rather than reporting it as failed.
    expect(result.indexed).toBe(1);
    expect(result.needsReview).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.unsupported).toBe(0);
    const f = result.files.find((x) => x.filename === "deck.key");
    expect(f?.status).toBe("indexed");
    expect(f?.aiExtracted).toBe(true);
    expect(f?.errorKind).toBeUndefined();
    // Searchable in FTS and tracked in panel_documents.
    expect(await panelFtsCount(db)).toBe(1);
    const docsRepo = new PanelDocumentRepository(db);
    const tracked = await docsRepo.listDocuments("ask-panel");
    expect(tracked).toHaveLength(1);
  });

  it("auto mode: a blocklisted .png is NOT AI-extracted and stays an unsupported failure", async () => {
    await fs.writeFile(path.join(managedDir, "shot.png"), "x", "utf-8");

    const result = await scanAndIndexPanelDocuments({
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "auto", allowedExtensions: [] },
    });

    // Blocklist always wins, even in `auto` mode: a `.png` is never
    // AI-extracted and remains an unsupported failure.
    expect(result.indexed).toBe(0);
    expect(result.unsupported).toBe(1);
    expect(result.failed).toBe(1);
    const f = result.files.find((x) => x.filename === "shot.png");
    expect(f?.status).toBe("failed");
    expect(f?.errorKind).toBe("unsupported-format");
    expect(await panelFtsCount(db)).toBe(0);
  });

  it("auto mode: re-scanning an already-extracted file reports it unchanged (no re-index churn)", async () => {
    await fs.writeFile(path.join(managedDir, "deck.key"), "keynote outline", "utf-8");
    const opts = {
      panelName: "ask-panel",
      managedDocsDir: managedDir,
      db,
      supportedFormats: [".md", ".txt"],
      aiFallback: { mode: "auto" as const, allowedExtensions: [] },
    };

    const first = await scanAndIndexPanelDocuments(opts);
    expect(first.indexed).toBe(1);

    // The detector never tracks unsupported-extension files, so `.key`
    // reappears in `unsupportedFiles` on every scan. The scanner must
    // recognize the unchanged checksum and report `unchanged` instead of
    // re-indexing (which would churn FTS rows on every chat startup).
    const second = await scanAndIndexPanelDocuments(opts);
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.failed).toBe(0);
    const f = second.files.find((x) => x.filename === "deck.key");
    expect(f?.status).toBe("unchanged");
    // Still exactly one FTS row and one tracked doc — no duplication.
    expect(await panelFtsCount(db)).toBe(1);
    const docsRepo = new PanelDocumentRepository(db);
    const tracked = await docsRepo.listDocuments("ask-panel");
    expect(tracked).toHaveLength(1);
  });
});

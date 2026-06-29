/**
 * Tests for detectDocumentChanges — Roadmap 6.1.
 *
 * RED at this commit: src/core/documents/detector.ts does not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { detectDocumentChanges } from "../../../../src/core/documents/detector.js";
import { mkCanonicalTempDir } from "../../../helpers/tmp.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("detectDocumentChanges", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkCanonicalTempDir("council-detect-");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("classifies all files as new when knownChecksums is empty", async () => {
    await fs.writeFile(path.join(dir, "a.md"), "# A");
    await fs.writeFile(path.join(dir, "b.txt"), "hello");
    const result = await detectDocumentChanges(dir, new Map(), [".md", ".txt", ".html"]);
    expect(result.newFiles).toHaveLength(2);
    expect(result.modifiedFiles).toHaveLength(0);
    expect(result.unchangedFiles).toHaveLength(0);
    expect(result.unsupportedFiles).toHaveLength(0);
    const filenames = result.newFiles.map((f) => f.filename).sort();
    expect(filenames).toEqual(["a.md", "b.txt"]);
  });

  it("classifies file as unchanged when checksum matches", async () => {
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "# Hello world");
    const known = new Map<string, string>([[filePath, sha256("# Hello world")]]);
    const result = await detectDocumentChanges(dir, known, [".md"]);
    expect(result.unchangedFiles).toHaveLength(1);
    expect(result.newFiles).toHaveLength(0);
    expect(result.modifiedFiles).toHaveLength(0);
    expect(result.unchangedFiles[0]?.checksum).toBe(sha256("# Hello world"));
  });

  it("classifies file as modified when checksum differs", async () => {
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "new content");
    const known = new Map<string, string>([[filePath, sha256("old content")]]);
    const result = await detectDocumentChanges(dir, known, [".md"]);
    expect(result.modifiedFiles).toHaveLength(1);
    expect(result.newFiles).toHaveLength(0);
    expect(result.unchangedFiles).toHaveLength(0);
    expect(result.modifiedFiles[0]?.checksum).toBe(sha256("new content"));
  });

  it("filters out unsupported formats and reports them separately", async () => {
    await fs.writeFile(path.join(dir, "a.md"), "x");
    await fs.writeFile(path.join(dir, "b.pdf"), "x");
    await fs.writeFile(path.join(dir, "c.docx"), "x");
    const result = await detectDocumentChanges(dir, new Map(), [".md", ".txt", ".html"]);
    expect(result.newFiles.map((f) => f.filename)).toEqual(["a.md"]);
    expect(result.unsupportedFiles).toHaveLength(2);
    expect(result.unsupportedFiles.some((p) => p.endsWith("b.pdf"))).toBe(true);
    expect(result.unsupportedFiles.some((p) => p.endsWith("c.docx"))).toBe(true);
  });

  it("matches extensions case-insensitively", async () => {
    await fs.writeFile(path.join(dir, "A.MD"), "x");
    await fs.writeFile(path.join(dir, "B.HtMl"), "x");
    const result = await detectDocumentChanges(dir, new Map(), [".md", ".html"]);
    expect(result.newFiles).toHaveLength(2);
    expect(result.unsupportedFiles).toHaveLength(0);
  });

  it("recurses into subdirectories", async () => {
    await fs.mkdir(path.join(dir, "nested", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "top.md"), "t");
    await fs.writeFile(path.join(dir, "nested", "mid.md"), "m");
    await fs.writeFile(path.join(dir, "nested", "deep", "bottom.md"), "b");
    const result = await detectDocumentChanges(dir, new Map(), [".md"]);
    expect(result.newFiles).toHaveLength(3);
    const filenames = result.newFiles.map((f) => f.filename).sort();
    expect(filenames).toEqual(["bottom.md", "mid.md", "top.md"]);
  });

  it("returns absolute paths and ISO modifiedAt timestamps", async () => {
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "hello");
    const result = await detectDocumentChanges(dir, new Map(), [".md"]);
    const f = result.newFiles[0];
    if (!f) throw new Error("expected at least one new file");
    expect(path.isAbsolute(f.path)).toBe(true);
    expect(f.sizeBytes).toBe(5);
    expect(f.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty result for non-existent directory", async () => {
    const missing = path.join(dir, "does-not-exist");
    const result = await detectDocumentChanges(missing, new Map(), [".md"]);
    expect(result.newFiles).toHaveLength(0);
    expect(result.modifiedFiles).toHaveLength(0);
    expect(result.unchangedFiles).toHaveLength(0);
    expect(result.unsupportedFiles).toHaveLength(0);
  });

  // ── Roadmap 6.4: confinement-aware detection (TOCTOU-safe) ────────────
  describe("confinement (Roadmap 6.4)", () => {
    it("accepts files inside the confinement root", async () => {
      await fs.writeFile(path.join(dir, "a.md"), "ok");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
      });
      expect(result.newFiles).toHaveLength(1);
      expect(result.rejectedFiles ?? []).toHaveLength(0);
    });

    it("rejects symlinks whose target is outside the confinement root", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-outside-"));
      try {
        const secret = path.join(outside, "secret.md");
        await fs.writeFile(secret, "SECRET");
        try {
          await fs.symlink(secret, path.join(dir, "trap.md"));
        } catch {
          // Symlinks not permitted on this OS/account — skip.
          return;
        }
        const result = await detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
        });
        expect(result.newFiles.some((f) => f.filename === "trap.md")).toBe(false);
        expect((result.rejectedFiles ?? []).some((p) => p.endsWith("trap.md"))).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects symlinks whose target is outside the confinement root (cross-platform, #452)", async () => {
      // OS-agnostic twin of the test above: real symlinks require
      // Developer Mode/admin on Windows so that test skips there. Use
      // the `_lstatOverride` + `_realpathOverride` seams to synthesize a
      // symlink whose realpath escapes the confinement root — proving
      // the confinement rejection fires on every platform without a real
      // symlink. The outside target is a real file so readConfined's
      // post-open lstat of the canonical path succeeds, and the inode
      // mismatch vs the in-root fd is what trips the confinement guard.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-452-outside-"));
      try {
        const secret = path.join(outside, "secret.md");
        await fs.writeFile(secret, "SECRET");
        await fs.writeFile(path.join(dir, "trap.md"), "decoy");
        const trapAbs = path.resolve(dir, "trap.md");
        const realLstat = fs.lstat;
        const realRealpath = fs.realpath;

        const result = await detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
          _lstatOverride: async (p: string) => {
            const stat = await realLstat(p);
            if (path.resolve(p) === trapAbs) {
              return new Proxy(stat, {
                get(target, prop, receiver) {
                  if (prop === "isSymbolicLink") return () => true;
                  return Reflect.get(target, prop, receiver);
                },
              });
            }
            return stat;
          },
          _realpathOverride: async (p: string) =>
            path.resolve(p) === trapAbs ? secret : realRealpath(p),
        });

        expect(result.newFiles.some((f) => f.filename === "trap.md")).toBe(false);
        expect((result.rejectedFiles ?? []).some((p) => p.endsWith("trap.md"))).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects in-root files that resolve outside the confinement root with no symlink (#452)", async () => {
      // No symlink at all: confine to a sub-directory while a file lives
      // in the parent. Its canonical path is inside `dir` but outside the
      // sub-root, so isPathInside() must reject it. Fully deterministic on
      // every OS, requiring no symlink privileges.
      const subRoot = path.join(dir, "root");
      await fs.mkdir(subRoot, { recursive: true });
      await fs.writeFile(path.join(dir, "escape.md"), "outside-subroot");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: subRoot,
      });
      expect(result.newFiles.some((f) => f.filename === "escape.md")).toBe(false);
      expect((result.rejectedFiles ?? []).some((p) => p.endsWith("escape.md"))).toBe(true);
    });

    it("does NOT read file bytes via the unconfined path (uses fd-based reads)", async () => {
      // Sanity: a regular file inside confinement still produces a checksum.
      await fs.writeFile(path.join(dir, "a.md"), "hello fd");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
      });
      expect(result.newFiles).toHaveLength(1);
      expect(result.newFiles[0]?.checksum).toBe(sha256("hello fd"));
    });

    it("surfaces non-ENOENT readdir errors instead of silently returning empty", async () => {
      // Force a non-missing-directory error by passing a file path (ENOTDIR).
      const filePath = path.join(dir, "file.md");
      await fs.writeFile(filePath, "x");
      await expect(
        detectDocumentChanges(filePath, new Map(), [".md"], { confinementRoot: dir }),
      ).rejects.toThrow();
    });

    // ── Sentinel pr373 cycle 4: root-swap TOCTOU ─────────────────────
    it("does NOT re-resolve the confinement root when _rootIsCanonical is set", async () => {
      // Prove the frozen-root contract: when the caller asserts the
      // confinement root is already canonical, the detector must not
      // call realpath() on it again. We assert this by injecting an
      // override that THROWS for the root path — the call must still
      // succeed (because realpath is only invoked for the FILE, not
      // the root).
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      const canonical = await fs.realpath(dir);
      const rootArg = dir; // may equal canonical on this OS

      const calls: string[] = [];
      const override = async (p: string): Promise<string> => {
        calls.push(p);
        // Throw if the detector re-resolves the root — this proves
        // the bug we are guarding against.
        if (p === rootArg || p === canonical) {
          throw new Error(`detector re-resolved the root: ${p}`);
        }
        return fs.realpath(p);
      };

      const result = await detectDocumentChanges(canonical, new Map(), [".md"], {
        confinementRoot: canonical,
        _rootIsCanonical: true,
        _realpathOverride: override,
      });
      expect(result.newFiles).toHaveLength(1);
      // The override should have been called for the file but never for the root.
      expect(calls.every((p) => p !== rootArg && p !== canonical)).toBe(true);
    });
  });

  // ── Issue #374: fd-anchored root validation against scan-window TOCTOU ─
  describe("root-swap TOCTOU protection (#374)", () => {
    it("rejects the scan when the root directory's identity (dev/ino) changes between pre-readdir and post-readdir lstat", async () => {
      // Simulate a directory swap during the scan window: an attacker
      // (or a racy mount/replace) substitutes the docs root with a
      // different inode between the detector's entry validation and
      // its post-readdir verification. The detector MUST notice the
      // identity flip and refuse to return any results, otherwise
      // entries enumerated from the swapped directory would silently
      // be processed as if they came from the validated root.
      await fs.writeFile(path.join(dir, "a.md"), "hello");
      const realStat = await fs.lstat(dir);
      // Pick a swapped inode guaranteed to differ from the real one.
      // `realStat.ino + 1` is NOT safe on Windows: NTFS inode values
      // routinely exceed Number.MAX_SAFE_INTEGER (2^53), at which point
      // floating-point precision causes `ino + 1 === ino`, collapsing
      // the "swap" into a no-op and producing an intermittent flake
      // under parallel-suite load (which advances the file-index
      // counter into the unsafe range). Use a small sentinel that is
      // always distinct from a real temp-dir inode.
      const swappedIno = realStat.ino === 1 ? 2 : 1;
      let calls = 0;
      const rootLstatOverride = async (_p: string) => {
        calls += 1;
        // First call (pre-readdir): return the real identity.
        // Second call (post-readdir): return a different inode to
        // simulate the directory having been swapped out.
        if (calls === 1) return realStat;
        return {
          ...realStat,
          ino: swappedIno,
          dev: realStat.dev,
          isFile: () => realStat.isFile(),
          isDirectory: () => realStat.isDirectory(),
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.lstat>>;
      };

      await expect(
        detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
          _rootIsCanonical: true,
          _rootLstatOverride: rootLstatOverride,
        }),
      ).rejects.toThrow(/identity changed|root.*swap|TOCTOU/i);
    });

    it("succeeds when the root directory's identity is stable across the scan", async () => {
      // Back-compat / happy-path guard: the new check must not produce
      // false positives on a normal scan where the root inode is the
      // same before and after readdir.
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
        _rootIsCanonical: true,
      });
      expect(result.newFiles).toHaveLength(1);
      expect(result.newFiles[0]?.filename).toBe("a.md");
    });

    it("does not perform root-identity checks when no confinementRoot is provided", async () => {
      // When the caller has not opted into confinement, the detector
      // must remain back-compat: no root-identity checks and no calls
      // into the root-lstat seam. We assert the seam is never invoked.
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      let called = false;
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        _rootLstatOverride: async (p: string) => {
          called = true;
          return fs.lstat(p);
        },
      });
      expect(result.newFiles).toHaveLength(1);
      expect(called).toBe(false);
    });

    it("rejects when the fd-anchored stat reports a different inode than the pre-lstat (open-window swap)", async () => {
      // Sentinel #1: lock down the fd-stat mismatch branch. If the
      // directory was swapped between the pre-lstat and the fs.open()
      // call, the kernel-bound fd's stat will diverge from the lstat
      // identity. The detector MUST refuse the scan with the explicit
      // "identity changed between lstat and open" error.
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      const realStat = await fs.lstat(dir);
      // See "(dev/ino) changes" test above: `realStat.ino + 1` can
      // round back to `realStat.ino` on Windows because NTFS inodes
      // can exceed Number.MAX_SAFE_INTEGER. Use a sentinel inode
      // guaranteed to differ from any real temp-dir inode.
      const swappedIno = realStat.ino === 1 ? 2 : 1;

      const fakeHandle = {
        async stat() {
          return {
            ...realStat,
            ino: swappedIno,
            isFile: () => false,
            isDirectory: () => true,
          };
        },
        async close() {
          /* no-op for the test seam */
        },
      } as unknown as Awaited<ReturnType<typeof fs.open>>;

      await expect(
        detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
          _rootIsCanonical: true,
          _rootOpenOverride: async () => fakeHandle,
        }),
      ).rejects.toThrow(/identity changed between lstat and open/);
    });

    it("falls back gracefully when fs.open(<dir>) rejects with EISDIR (Windows path)", async () => {
      // Sentinel #3: prove the Windows graceful-fallback branch.
      // On Windows (and some POSIX configurations) `fs.open` of a
      // directory rejects with EISDIR/EACCES. The detector must NOT
      // surface that as a TOCTOU error — it should fall back to the
      // pre/post lstat compare and complete the scan normally.
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
        _rootIsCanonical: true,
        _rootOpenOverride: async () => {
          const err: NodeJS.ErrnoException = new Error("EISDIR: illegal operation on a directory");
          err.code = "EISDIR";
          throw err;
        },
      });
      expect(result.newFiles).toHaveLength(1);
      expect(result.newFiles[0]?.filename).toBe("a.md");
    });

    it("rethrows non-allowlisted fs.open errors instead of silently downgrading (Sentinel #1)", async () => {
      // Operational failures like EMFILE / EIO from `fs.open(<dir>)`
      // are NOT graceful-fallback signals — silently swallowing them
      // would weaken the advertised fd-anchored hardening AND hide a
      // real failure. The detector must surface these to the caller.
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      await expect(
        detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
          _rootIsCanonical: true,
          _rootOpenOverride: async () => {
            const err: NodeJS.ErrnoException = new Error("EMFILE: too many open files");
            err.code = "EMFILE";
            throw err;
          },
        }),
      ).rejects.toThrow(/EMFILE/);
    });

    it("rejects when fh.stat() throws an allowlisted code after a successful open (Sentinel re2 #1)", async () => {
      // Sentinel cycle 2 finding: once `fs.open()` succeeds, the root
      // fd has been bound to a real inode. A subsequent `rootHandle
      // .stat()` failure is NOT a "directory cannot be opened" signal
      // and must NOT funnel through the open-failure allowlist —
      // doing so would let an EACCES/EPERM/ENOTSUP/EINVAL on the
      // post-open verification silently downgrade the scan to
      // lstat-only mode, defeating the advertised fd-anchored
      // hardening. Verify the handle is still closed (no fd leak).
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      let closed = false;
      const stubHandle = {
        async stat(): Promise<never> {
          const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
          err.code = "EACCES";
          throw err;
        },
        async close() {
          closed = true;
        },
      } as unknown as Awaited<ReturnType<typeof fs.open>>;

      await expect(
        detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
          _rootIsCanonical: true,
          _rootOpenOverride: async () => stubHandle,
        }),
      ).rejects.toThrow(/EACCES/);
      expect(closed).toBe(true);
    });
  });

  // ── Issue #339: symlink traversal guard (no confinementRoot) ──────
  describe("symlink traversal (#339)", () => {
    it("rejects symlinks pointing outside the project when no confinementRoot is set", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-339-outside-"));
      try {
        const secret = path.join(outside, "secret.md");
        await fs.writeFile(secret, "SECRET");
        try {
          await fs.symlink(secret, path.join(dir, "trap.md"));
        } catch {
          // Symlinks not permitted on this OS/account (Windows w/o
          // Developer Mode or admin — see issue #452). Skip gracefully.
          return;
        }
        const warnings: string[] = [];
        const result = await detectDocumentChanges(dir, new Map(), [".md"], {
          onWarning: (msg) => warnings.push(msg),
        });
        // Symlink must NOT be classified as a normal file — its bytes
        // must never have been hashed (the file lives outside the
        // project root).
        expect(result.newFiles.some((f) => f.filename === "trap.md")).toBe(false);
        expect(result.modifiedFiles.some((f) => f.filename === "trap.md")).toBe(false);
        expect(result.unchangedFiles.some((f) => f.filename === "trap.md")).toBe(false);
        // The trap path must be reported in `rejectedFiles` so callers
        // doing reconciliation see a definitive "do not index" signal.
        expect(result.rejectedFiles.some((p) => p.endsWith("trap.md"))).toBe(true);
        // A warning must name the symlink so users can diagnose.
        expect(warnings.some((w) => w.includes("trap.md"))).toBe(true);
        expect(warnings.some((w) => /symlink|symbolic link/i.test(w))).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects symlinks pointing inside the project when no confinementRoot is set", async () => {
      // Without a confinementRoot we cannot prove a symlink target is
      // safe (today inside-root, tomorrow swapped to outside-root via
      // a TOCTOU race on the link). Default-deny is the safe choice.
      await fs.writeFile(path.join(dir, "real.md"), "real");
      try {
        await fs.symlink(path.join(dir, "real.md"), path.join(dir, "link.md"));
      } catch {
        return;
      }
      const warnings: string[] = [];
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        onWarning: (msg) => warnings.push(msg),
      });
      // The real file is indexed normally.
      expect(result.newFiles.some((f) => f.filename === "real.md")).toBe(true);
      // The symlink is rejected (default-deny w/o confinement) and a
      // warning is emitted naming the link.
      expect(result.newFiles.some((f) => f.filename === "link.md")).toBe(false);
      expect(result.rejectedFiles.some((p) => p.endsWith("link.md"))).toBe(true);
      expect(warnings.some((w) => w.includes("link.md"))).toBe(true);
    });

    it("rejects symlinks via _lstatOverride seam (cross-platform RED)", async () => {
      // Cross-platform deterministic guard: real symlinks require
      // Developer Mode/admin on Windows (#452) so the OS-level tests
      // above skip there. This test uses the `_lstatOverride` seam to
      // synthesize a symlink Stats object regardless of platform —
      // proving the detector's symlink check fires unconditionally.
      await fs.writeFile(path.join(dir, "real.md"), "real");
      await fs.writeFile(path.join(dir, "fake-link.md"), "doesn't matter");
      const linkAbs = path.resolve(dir, "fake-link.md");
      const realLstat = fs.lstat;

      const warnings: string[] = [];
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        onWarning: (msg) => warnings.push(msg),
        _lstatOverride: async (p: string) => {
          const stat = await realLstat(p);
          if (path.resolve(p) === linkAbs) {
            // Wrap the real Stats so isSymbolicLink() returns true.
            return new Proxy(stat, {
              get(target, prop, receiver) {
                if (prop === "isSymbolicLink") return () => true;
                if (prop === "isFile") return () => false;
                return Reflect.get(target, prop, receiver);
              },
            });
          }
          return stat;
        },
      });

      expect(result.newFiles.map((f) => f.filename)).toEqual(["real.md"]);
      expect(result.rejectedFiles).toContain(linkAbs);
      expect(warnings.some((w) => w.includes("fake-link.md"))).toBe(true);
      expect(warnings.some((w) => /symlink|symbolic link/i.test(w))).toBe(true);
    });

    it("indexes regular (non-symlink) files normally when no confinementRoot is set", async () => {
      // Regression guard: the symlink check must not affect plain files.
      await fs.writeFile(path.join(dir, "a.md"), "alpha");
      await fs.writeFile(path.join(dir, "b.md"), "bravo");
      const warnings: string[] = [];
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        onWarning: (msg) => warnings.push(msg),
      });
      expect(result.newFiles.map((f) => f.filename).sort()).toEqual(["a.md", "b.md"]);
      expect(result.rejectedFiles).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    });
  });

  // ── Sentinel #341 / #342: error surfacing & per-file resilience ─────
  describe("error surfacing (#341, #342)", () => {
    it("wraps readdir failures with a descriptive message naming the docsPath (#341)", async () => {
      // ENOTDIR (passing a regular file) is a typical misconfiguration:
      // a stray empty message is unhelpful — callers need to see WHICH
      // path failed and WHY, with a stable prefix they can recognize.
      const filePath = path.join(dir, "regular-file.md");
      await fs.writeFile(filePath, "x");
      await expect(detectDocumentChanges(filePath, new Map(), [".md"])).rejects.toThrow(
        /document scan failed/i,
      );
      await expect(detectDocumentChanges(filePath, new Map(), [".md"])).rejects.toThrow(
        new RegExp(filePath.replace(/\\/g, "\\\\")),
      );
    });

    it("invokes onWarning and continues when a single file's lstat fails (#342)", async () => {
      // Use the `_lstatOverride` test seam to simulate one file's stat
      // failing mid-scan (e.g. a transient EBUSY / ENOENT race) without
      // mutating the actual filesystem. The two healthy files must still
      // be classified normally and a warning must name the broken file.
      await fs.writeFile(path.join(dir, "a.md"), "alpha");
      await fs.writeFile(path.join(dir, "b.md"), "bravo");
      await fs.writeFile(path.join(dir, "ghost.md"), "ghost");

      const ghostAbs = path.resolve(dir, "ghost.md");
      const realLstat = fs.lstat;
      const warnings: string[] = [];

      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        onWarning: (msg) => warnings.push(msg),
        _lstatOverride: async (p: string) => {
          if (path.resolve(p) === ghostAbs) {
            const err: NodeJS.ErrnoException = new Error("ENOENT: no such file");
            err.code = "ENOENT";
            throw err;
          }
          return realLstat(p);
        },
      });

      // The two healthy files were processed.
      const names = result.newFiles.map((f) => f.filename).sort();
      expect(names).toEqual(["a.md", "b.md"]);
      // Ghost file did not bring the scan down — it was skipped, and a
      // warning naming the file + error was emitted.
      expect(warnings.length).toBe(1);
      const warning = warnings[0] ?? "";
      expect(warning).toContain("ghost.md");
      expect(warning).toMatch(/lstat|stat|ENOENT/i);
    });

    it("surfaces lstat-failed files in unknownStateFiles so deletion reconciliation does not prune them (#342)", async () => {
      // CRITICAL regression guard. `DocumentProcessor.process()` and
      // `panel-document-scanner` build their `seenPaths` set from
      // `newFiles ∪ modifiedFiles ∪ unchangedFiles ∪ rejectedFiles ∪
      // unknownStateFiles`. Any tracked file NOT in that set is
      // reconciled as "deleted on disk" and pruned from the FTS index
      // + marked removed in `expert_documents` / `panel_documents`. A
      // transient `lstat` failure that silently skips a file would
      // therefore cause permanent data loss. The detector must report
      // stat-failed files in `unknownStateFiles` (NOT `rejectedFiles`,
      // which is reserved for hard confinement / TOCTOU rejections that
      // panel-doc reconciliation is allowed to prune) so callers
      // preserve them.
      await fs.writeFile(path.join(dir, "ghost.md"), "ghost");
      const ghostAbs = path.resolve(dir, "ghost.md");

      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        _lstatOverride: async (p: string) => {
          if (path.resolve(p) === ghostAbs) {
            const err: NodeJS.ErrnoException = new Error("EBUSY: busy");
            err.code = "EBUSY";
            throw err;
          }
          return fs.lstat(p);
        },
      });

      expect(result.newFiles).toHaveLength(0);
      expect(result.unknownStateFiles).toContain(ghostAbs);
      // Hard-rejection bucket must NOT contain transient failures, or
      // panel-doc reconciliation will skip pruning paths it should
      // legitimately prune (and silently keep stale content).
      expect(result.rejectedFiles).not.toContain(ghostAbs);
    });

    it("invokes onWarning when readConfined throws mid-scan and continues (#342)", async () => {
      // A second per-file failure mode: post-open read/confinement
      // failure. The `_realpathOverride` seam lets us throw inside
      // `readConfined()` for a specific file. The remaining files must
      // be processed, and a warning must name the broken file with a
      // "read failed" tag. Like lstat failures, an error thrown from
      // `readConfined` is treated as transient (`unknownStateFiles`)
      // because the failure mode (EIO, EACCES, realpath error) does
      // NOT prove the file is invalid — only that we couldn't read it
      // this scan. A `null` return from `readConfined` is the hard
      // TOCTOU/confinement signal and stays in `rejectedFiles`.
      await fs.writeFile(path.join(dir, "a.md"), "alpha");
      await fs.writeFile(path.join(dir, "broken.md"), "broken");
      const brokenAbs = path.resolve(dir, "broken.md");

      const warnings: string[] = [];
      const realRealpath = fs.realpath;
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
        onWarning: (msg) => warnings.push(msg),
        _realpathOverride: async (p: string) => {
          if (path.resolve(p) === brokenAbs) {
            throw new Error("simulated readConfined failure");
          }
          return realRealpath(p);
        },
      });

      const names = result.newFiles.map((f) => f.filename).sort();
      expect(names).toEqual(["a.md"]);
      expect(result.unknownStateFiles).toContain(brokenAbs);
      expect(result.rejectedFiles).not.toContain(brokenAbs);
      expect(warnings.length).toBe(1);
      const warning = warnings[0] ?? "";
      expect(warning).toContain("broken.md");
      expect(warning).toMatch(/read failed|simulated readConfined/i);
    });
  });

  // #649: `_realpathOverride` bypasses confinement/TOCTOU validation. It must
  // take effect ONLY under test (NODE_ENV === "test"). In production it must
  // be ignored so the real fs.realpath confinement check runs.
  describe("test-only override gating (#649)", () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("honors _realpathOverride when NODE_ENV='test'", async () => {
      process.env.NODE_ENV = "test";
      await fs.writeFile(path.join(dir, "a.md"), "alpha");
      await fs.writeFile(path.join(dir, "broken.md"), "broken");
      const brokenAbs = path.resolve(dir, "broken.md");
      const realRealpath = fs.realpath;
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
        _realpathOverride: async (p: string) => {
          if (path.resolve(p) === brokenAbs) throw new Error("seam error");
          return realRealpath(p);
        },
      });
      expect(result.newFiles.map((f) => f.filename).sort()).toEqual(["a.md"]);
      expect(result.unknownStateFiles).toContain(brokenAbs);
    });

    it("ignores _realpathOverride in production (real fs path taken)", async () => {
      process.env.NODE_ENV = "production";
      await fs.writeFile(path.join(dir, "a.md"), "alpha");
      await fs.writeFile(path.join(dir, "broken.md"), "broken");
      const brokenAbs = path.resolve(dir, "broken.md");
      const realRealpath = fs.realpath;
      // Honored, the override would throw for broken.md → unknownState; gated
      // off, real realpath resolves both inside confinement → both new.
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
        _realpathOverride: async (p: string) => {
          if (path.resolve(p) === brokenAbs) throw new Error("seam error");
          return realRealpath(p);
        },
      });
      expect(result.newFiles.map((f) => f.filename).sort()).toEqual(["a.md", "broken.md"]);
      expect(result.unknownStateFiles).not.toContain(brokenAbs);
    });
  });
});

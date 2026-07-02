import { beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs/promises";
import path from "node:path";

import type { ProcessingResult } from "../../../src/core/documents/processor.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import {
  createExpertTrainingSource,
  stageDocumentFiles,
  type ExpertTrainingDeps,
} from "../../../src/tui/adapters/expert-training.js";
import { mkCanonicalTempDir } from "../../helpers/tmp.js";

// The stageDocumentFiles suite drives real temp directories, so `lstat` and
// `copyFile` keep their real behaviour by default (the factory wraps the real
// implementations). Wrapping just these two lets the robustness tests inject a
// non-ENOENT destination lstat error or a mid-batch copy failure — ESM module
// namespaces cannot be spied, so the module itself must be mocked (mirroring
// the template-migration / loader-lock fs-error tests).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), copyFile: vi.fn(actual.copyFile) };
});

class StubEngine implements CouncilEngine {
  readonly started = vi.fn(async (): Promise<void> => undefined);
  readonly stopped = vi.fn(async (): Promise<void> => undefined);
  readonly registered: ExpertSpec[] = [];
  readonly removed: string[] = [];

  async start(): Promise<void> {
    await this.started();
  }

  async stop(): Promise<void> {
    await this.stopped();
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

  send(_opts: SendOptions): AsyncIterable<EngineEvent> {
    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      yield { kind: "message.delta", expertId: "stub", text: "" };
    })();
  }
}

const resultFor = (overrides: Partial<ProcessingResult> = {}): ProcessingResult => ({
  filesProcessed: 1,
  filesSkipped: 0,
  filesFailed: 0,
  filesRemoved: 0,
  filesUnsupported: 0,
  filesNeedingReview: 0,
  totalWords: 42,
  profileUpdated: true,
  profileError: null,
  files: [],
  ...overrides,
});

function makeDeps(overrides: Partial<ExpertTrainingDeps> = {}): {
  readonly deps: ExpertTrainingDeps;
  readonly engine: StubEngine;
  readonly stageFiles: ReturnType<typeof vi.fn<ExpertTrainingDeps["stageFiles"]>>;
  readonly process: ReturnType<typeof vi.fn>;
} {
  const engine = new StubEngine();
  const stageFiles = vi.fn<ExpertTrainingDeps["stageFiles"]>(async () => undefined);
  const process = vi.fn(
    async (
      _slug: string,
      _docsPath: string,
      onProgress?: (p: {
        readonly filename: string;
        readonly wordCount: number;
        readonly status: "success" | "failed" | "needs-review";
        readonly error?: string;
      }) => void,
    ) => {
      onProgress?.({
        filename: "\u001b[31mnotes.md\nspoof",
        wordCount: 42,
        status: "failed",
        error: "\u001b[32mbad\nline",
      });
      return resultFor({ profileError: "\u001b[33mprofile\nfailed" });
    },
  );
  const deps: ExpertTrainingDeps = {
    loadExpertKind: async () => "persona",
    stageFiles,
    docsPathFor: () => "/docs/cto",
    createProcessor: () => ({
      process,
      needsProcessing: async () => true,
    }),
    engineFactory: () => engine,
    ...overrides,
  };
  return { deps, engine, stageFiles, process };
}

describe("createExpertTrainingSource", () => {
  it("throws when the expert is not found", async () => {
    const { deps } = makeDeps({ loadExpertKind: async () => undefined });

    await expect(createExpertTrainingSource(deps).train("missing", { files: [] })).rejects.toThrow(
      'Expert "missing" not found.',
    );
  });

  it("throws when the expert is not a persona", async () => {
    const { deps } = makeDeps({ loadExpertKind: async () => "generic" });

    await expect(createExpertTrainingSource(deps).train("ops", { files: [] })).rejects.toThrow(
      'Expert "ops" is not a persona expert — only persona experts can be trained.',
    );
  });

  it("stages files, starts the engine, processes docs, sanitizes progress and result, and stops", async () => {
    const { deps, engine, stageFiles, process } = makeDeps();
    const progress: unknown[] = [];

    const result = await createExpertTrainingSource(deps).train(
      "cto",
      { files: ["/local/notes.md"] },
      (p) => progress.push(p),
    );

    expect(stageFiles).toHaveBeenCalledWith("cto", ["/local/notes.md"]);
    expect(engine.started).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledWith("cto", "/docs/cto", expect.any(Function));
    expect(progress).toEqual([
      { filename: "notes.md spoof", wordCount: 42, status: "failed", error: "bad line" },
    ]);
    expect(result).toEqual({
      filesProcessed: 1,
      filesFailed: 0,
      filesSkipped: 0,
      filesNeedingReview: 0,
      totalWords: 42,
      profileUpdated: true,
      profileError: "profile failed",
    });
    expect(engine.stopped).toHaveBeenCalledTimes(1);
  });

  it("does not stage files when no file input is provided", async () => {
    const { deps, stageFiles } = makeDeps();

    await createExpertTrainingSource(deps).train("cto", { files: [] });

    expect(stageFiles).not.toHaveBeenCalled();
  });

  it("stops the engine and propagates when processing rejects", async () => {
    const boom = new Error("boom");
    const { deps, engine } = makeDeps({
      createProcessor: () => ({
        process: async () => {
          throw boom;
        },
        needsProcessing: async () => true,
      }),
    });

    await expect(createExpertTrainingSource(deps).train("cto", { files: [] })).rejects.toBe(boom);
    expect(engine.stopped).toHaveBeenCalledTimes(1);
  });

  it("maps null profile errors and progress entries without an error field", async () => {
    const { deps } = makeDeps({
      createProcessor: () => ({
        process: async (_slug, _docsPath, onProgress) => {
          onProgress?.({ filename: "clean.md", wordCount: 9, status: "success" });
          return resultFor({ profileError: null });
        },
        needsProcessing: async () => true,
      }),
    });
    const progress: unknown[] = [];

    const result = await createExpertTrainingSource(deps).train("cto", { files: [] }, (item) => {
      progress.push(item);
    });

    expect(progress).toEqual([{ filename: "clean.md", wordCount: 9, status: "success" }]);
    expect(result.profileError).toBeNull();
    // A successful train + successful stop must not fabricate a stop warning.
    expect(result.stopWarning).toBeUndefined();
  });

  it("surfaces a failing engine.stop() as a warning while preserving the training result", async () => {
    const { deps, engine } = makeDeps();
    engine.stopped.mockRejectedValueOnce(new Error("stop failed"));

    const result = await createExpertTrainingSource(deps).train("cto", { files: [] });

    // Secondary signal: the shutdown failure is reported, not silently swallowed.
    expect(result.stopWarning).toBe("Engine shutdown failed: stop failed");
    // Primary outcome is preserved exactly.
    expect(result.filesProcessed).toBe(1);
    expect(result.totalWords).toBe(42);
    expect(result.profileUpdated).toBe(true);
    expect(engine.stopped).toHaveBeenCalledTimes(1);
  });

  it("collapses control characters in the surfaced stop() warning to a single safe line", async () => {
    const { deps, engine } = makeDeps();
    const nasty =
      "stop\u001b[31m\u0000\u009b\u007f\u202e\u2066\u2069fail\r\ned\u2028now\u2029end\ttail";
    engine.stopped.mockRejectedValueOnce(new Error(nasty));

    const result = await createExpertTrainingSource(deps).train("cto", { files: [] });

    const warning = result.stopWarning ?? "";
    expect(warning).toBe("Engine shutdown failed: stopfail ed now end tail");
    expect(warning).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
    );
    expect(warning.split("\n")).toHaveLength(1);
  });

  it("propagates the primary training error and never lets a failing stop() mask it", async () => {
    const boom = new Error("training boom");
    const { deps, engine } = makeDeps({
      createProcessor: () => ({
        process: async () => {
          throw boom;
        },
        needsProcessing: async () => true,
      }),
    });
    engine.stopped.mockRejectedValueOnce(new Error("stop failed too"));

    await expect(createExpertTrainingSource(deps).train("cto", { files: [] })).rejects.toBe(boom);
    expect(engine.stopped).toHaveBeenCalledTimes(1);
  });
});

describe("stageDocumentFiles", () => {
  let actualFs: typeof fs;

  beforeEach(async () => {
    // Reset both mocks to a clean real-fs pass-through before every test so a
    // prior test's injected lstat/copyFile failure can never bleed across
    // cases. `mockReset` also drains any leftover one-shot implementation.
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.lstat).mockReset();
    vi.mocked(fs.lstat).mockImplementation(actualFs.lstat);
    vi.mocked(fs.copyFile).mockReset();
    vi.mocked(fs.copyFile).mockImplementation(actualFs.copyFile);
  });

  it("copies regular files into a freshly created docs directory", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const src = path.join(home, "notes.md");
      await fs.writeFile(src, "hello", "utf8");
      const docsPath = path.join(home, "experts", "cto", "docs");

      await stageDocumentFiles(docsPath, [src]);

      expect(await fs.readFile(path.join(docsPath, "notes.md"), "utf8")).toBe("hello");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects symlinked source paths instead of following them", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const secret = path.join(home, "secret.txt");
      await fs.writeFile(secret, "top-secret", "utf8");
      const link = path.join(home, "link.md");
      await fs.symlink(secret, link);
      const docsPath = path.join(home, "docs");

      await expect(stageDocumentFiles(docsPath, [link])).rejects.toThrow(/not a (regular )?file/i);
      await expect(fs.readFile(path.join(docsPath, "link.md"), "utf8")).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects directory source paths", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const dir = path.join(home, "a-dir");
      await fs.mkdir(dir, { recursive: true });
      await expect(stageDocumentFiles(path.join(home, "docs"), [dir])).rejects.toThrow(
        /not a (regular )?file/i,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing staged document", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const docsPath = path.join(home, "docs");
      await fs.mkdir(docsPath, { recursive: true });
      await fs.writeFile(path.join(docsPath, "notes.md"), "original", "utf8");
      const src = path.join(home, "notes.md");
      await fs.writeFile(src, "replacement", "utf8");

      await expect(stageDocumentFiles(docsPath, [src])).rejects.toThrow(/already exists/i);
      expect(await fs.readFile(path.join(docsPath, "notes.md"), "utf8")).toBe("original");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("propagates a non-ENOENT destination lstat error instead of swallowing it", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const src = path.join(home, "notes.md");
      await fs.writeFile(src, "hello", "utf8");
      const docsPath = path.join(home, "docs");
      const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });

      // Two lstat calls happen for a single-file batch: first the SOURCE (must
      // succeed so we reach the destination probe), then the DESTINATION
      // existence probe — which we fail with EACCES. A non-ENOENT error there
      // must PROPAGATE, never be misread as "destination absent" and allow the
      // copy to proceed.
      vi.mocked(fs.lstat)
        .mockImplementationOnce(actualFs.lstat)
        .mockImplementationOnce(async () => {
          throw eacces;
        });

      await expect(stageDocumentFiles(docsPath, [src])).rejects.toMatchObject({ code: "EACCES" });
      // Discriminating: the error was not swallowed, so NO copy was attempted
      // and nothing landed in the docs directory.
      expect(fs.copyFile).not.toHaveBeenCalled();
      await expect(actualFs.readFile(path.join(docsPath, "notes.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a source larger than maxFileSizeMB before copying it", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const src = path.join(home, "big.md");
      // One byte over a 1 MB ceiling (1 MB === 1024 * 1024 bytes).
      await fs.writeFile(src, Buffer.alloc(1024 * 1024 + 1, 0x61));
      const docsPath = path.join(home, "docs");

      await expect(stageDocumentFiles(docsPath, [src], { maxFileSizeMB: 1 })).rejects.toThrow(
        /too large|exceeds|limit/i,
      );

      // Discriminating: rejection happens BEFORE any copy, so nothing is staged.
      expect(fs.copyFile).not.toHaveBeenCalled();
      await expect(actualFs.readFile(path.join(docsPath, "big.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("stages a source that is exactly at the maxFileSizeMB ceiling", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const src = path.join(home, "exact.md");
      // Exactly 1 MB — the ceiling itself must be accepted (strict `>` bound).
      await fs.writeFile(src, Buffer.alloc(1024 * 1024, 0x62));
      const docsPath = path.join(home, "docs");

      await stageDocumentFiles(docsPath, [src], { maxFileSizeMB: 1 });

      expect(await actualFs.readFile(path.join(docsPath, "exact.md"))).toHaveLength(1024 * 1024);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rolls back an already-staged file when a later file fails mid-batch", async () => {
    const home = await mkCanonicalTempDir("council-stage-");
    try {
      const a = path.join(home, "a.md");
      const b = path.join(home, "b.md");
      await fs.writeFile(a, "aaa", "utf8");
      await fs.writeFile(b, "bbb", "utf8");
      const docsPath = path.join(home, "docs");
      const eio = Object.assign(new Error("i/o error"), { code: "EIO" });

      // a.md copies for real; b.md's copy then fails after a.md is on disk.
      vi.mocked(fs.copyFile)
        .mockImplementationOnce(actualFs.copyFile)
        .mockImplementationOnce(async () => {
          throw eio;
        });

      await expect(stageDocumentFiles(docsPath, [a, b])).rejects.toMatchObject({ code: "EIO" });

      // Atomicity: the batch failed, so NO file staged in this call may remain —
      // a.md must have been rolled back, and b.md never landed.
      await expect(actualFs.readFile(path.join(docsPath, "a.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(actualFs.readFile(path.join(docsPath, "b.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

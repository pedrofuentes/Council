import { describe, expect, it, vi } from "vitest";

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
  });

  it("ignores stop failures while preserving the training result", async () => {
    const { deps, engine } = makeDeps();
    engine.stopped.mockRejectedValueOnce(new Error("stop failed"));

    await expect(
      createExpertTrainingSource(deps).train("cto", { files: [] }),
    ).resolves.toMatchObject({
      filesProcessed: 1,
    });
  });
});

describe("stageDocumentFiles", () => {
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
});

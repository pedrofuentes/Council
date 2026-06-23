/**
 * Tests for `createTuiTrainingSource` — the wiring that builds the real,
 * engine-backed expert-training data source consumed by the COUNCIL_TUI.
 *
 * These exercise the factory end-to-end with the deterministic `mock`
 * engine and a throwaway database so every wiring closure (expert-kind
 * lookup, file staging, processor construction, engine construction) runs
 * offline.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigSchema } from "../../../src/config/schema.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import type { FileExpertLibrary } from "../../../src/core/expert-library.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { createTuiTrainingSource } from "../../../src/tui/training-source-factory.js";
import { copyTemplateDb } from "../../helpers/template-db.js";
import { mkCanonicalTempDir } from "../../helpers/tmp.js";

const config = ConfigSchema.parse({ defaults: { engine: "mock" } });

const libraryReturning = (result: ExpertDefinition | null): Pick<FileExpertLibrary, "get"> => ({
  get: vi.fn(async () => result),
});

const persona = { kind: "persona" } as unknown as ExpertDefinition;
const generic = { kind: "generic" } as unknown as ExpertDefinition;

describe("createTuiTrainingSource", () => {
  let db: CouncilDatabase;
  let home: string;

  beforeEach(async () => {
    home = await mkCanonicalTempDir("council-tui-train-");
    const dbPath = path.join(home, "council.db");
    await copyTemplateDb(dbPath);
    db = await createDatabase(dbPath);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("stages the document and runs the processor for a persona expert", async () => {
    const dataHome = path.join(home, "data");
    const srcFile = path.join(home, "notes.md");
    await fs.writeFile(srcFile, "# Notes\nPedro Fuentes prefers clear designs.\n", "utf8");

    const source = createTuiTrainingSource({
      config,
      dataHome,
      db,
      expertLibrary: libraryReturning(persona),
    });

    const seen: string[] = [];
    const result = await source.train("cto", { files: [srcFile] }, (p) => seen.push(p.filename));

    const staged = await fs.readFile(
      path.join(dataHome, "experts", "cto", "docs", "notes.md"),
      "utf8",
    );
    expect(staged).toContain("Pedro Fuentes");
    expect(typeof result.filesProcessed).toBe("number");
    expect(typeof result.profileUpdated).toBe("boolean");
  });

  it("rejects training a non-persona expert", async () => {
    const source = createTuiTrainingSource({
      config,
      dataHome: path.join(home, "data2"),
      db,
      expertLibrary: libraryReturning(generic),
    });

    await expect(source.train("pm", { files: [] })).rejects.toThrow(/persona/);
  });

  it("throws when a staged path is not a regular file", async () => {
    const dataHome = path.join(home, "data3");
    const dirPath = path.join(home, "a-directory");
    await fs.mkdir(dirPath, { recursive: true });

    const source = createTuiTrainingSource({
      config,
      dataHome,
      db,
      expertLibrary: libraryReturning(persona),
    });

    await expect(source.train("cto", { files: [dirPath] })).rejects.toThrow(/not a file/);
  });
});

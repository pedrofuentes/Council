/**
 * Integrity tests for FileExpertLibrary (#288).
 *
 * A DB `expert_library` row whose backing YAML file has been deleted is a
 * storage inconsistency. Previously `get()`/`list()` swallowed the ENOENT
 * silently (returning null / skipping the row), hiding the corruption.
 *
 * These tests assert that the mismatch now surfaces an OBSERVABLE, sanitized
 * structured diagnostic naming the affected slug, while:
 *   - the read contract is preserved (get() -> null, list() skips), and
 *   - a genuinely-absent expert (no row, no YAML) stays silent, and
 *   - a healthy row + YAML still loads with no diagnostic.
 *
 * RED at the test-only commit: readYaml() currently returns null on ENOENT
 * without emitting any diagnostic, so the console.warn assertions fail.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertLibraryRepository } from "../../../src/memory/repositories/expert-library-repo.js";

// Terminal/error-sink hostile codepoints: TAB, C0, DEL, C1, bidi
// override/isolate, CR/LF and Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function makeDef(overrides: Partial<ExpertDefinition> = {}): ExpertDefinition {
  return {
    slug: "cto",
    displayName: "Dahlia Renner (CTO)",
    role: "Skeptical CTO with 20 years of experience",
    kind: "generic",
    expertise: {
      weightedEvidence: ["production incident data"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Bayesian skeptic",
    ...overrides,
  };
}

describe("FileExpertLibrary integrity (#288)", () => {
  let db: CouncilDatabase;
  let dataHome: string;
  let lib: FileExpertLibrary;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-integrity-"));
    lib = new FileExpertLibrary(dataHome, db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
    await fs.rm(dataHome, { recursive: true, force: true });
  });

  describe("get() with a DB row but missing YAML", () => {
    it("returns null (preserving the read contract) AND warns with the exact integrity diagnostic naming the slug", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.unlink(yamlPath);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await lib.get("cto");

      expect(result).toBeNull();
      const expectedMessage = `[expert-library] Integrity: expert "cto" has a library record but its backing YAML file is missing (${yamlPath}). Treating it as absent until the file is restored or the record is removed.`;
      expect(warnSpy).toHaveBeenCalledWith(expectedMessage);
    });
  });

  describe("list() with a DB row but missing YAML", () => {
    it("skips the row (preserving the read contract) AND warns with the exact integrity diagnostic naming the slug", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.unlink(yamlPath);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await lib.list();

      expect(result).toEqual([]);
      const expectedMessage = `[expert-library] Integrity: expert "cto" has a library record but its backing YAML file is missing (${yamlPath}). Treating it as absent until the file is restored or the record is removed.`;
      expect(warnSpy).toHaveBeenCalledWith(expectedMessage);
    });
  });

  describe("adversarial slug is sanitized before it reaches the terminal sink", () => {
    // A slug carrying TAB, C0, DEL, C1, bidi override/isolate, CR/LF and
    // U+2028/U+2029. Slugs are validated on create()/update(), but get() and
    // list() read slugs straight from the DB row (which can be tampered) and
    // do not re-validate — so the diagnostic MUST sanitize before display.
    const adversarialSlug =
      "ev\u0009il\u0001\u001f\u007f\u0085\u009b\u202e\u2066\r\ncto\u2028\u2029";

    async function seedAdversarialGhost(): Promise<void> {
      const repo = new ExpertLibraryRepository(db);
      // yamlPath points at a file that never exists -> readYaml() hits ENOENT.
      await repo.create({
        slug: adversarialSlug,
        kind: "generic",
        displayName: "Adversarial Ghost",
        yamlPath: path.join(dataHome, "experts", "phantom.yaml"),
        yamlChecksum: "deadbeef",
      });
    }

    it("get(): surfaced diagnostic contains no control/bidi bytes and is single-line", async () => {
      await seedAdversarialGhost();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await lib.get(adversarialSlug);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const surfaced = warnSpy.mock.calls[0]?.[0] as string;
      expect(surfaced).toContain("[expert-library] Integrity:");
      expect(surfaced).not.toMatch(UNSAFE_CONTROL_RE);
      expect(surfaced).not.toMatch(/[\r\n]/);
    });

    it("list(): surfaced diagnostic contains no control/bidi bytes and is single-line", async () => {
      await seedAdversarialGhost();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await lib.list();

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const surfaced = warnSpy.mock.calls[0]?.[0] as string;
      expect(surfaced).toContain("[expert-library] Integrity:");
      expect(surfaced).not.toMatch(UNSAFE_CONTROL_RE);
      expect(surfaced).not.toMatch(/[\r\n]/);
    });
  });

  describe("inverse invariants: no false positives", () => {
    it("get(): a genuinely-absent expert (no row, no YAML) returns null with NO diagnostic", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = await lib.get("never-existed");

      expect(result).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("list(): an empty library returns [] with NO diagnostic", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = await lib.list();

      expect(result).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("get()/list(): a healthy row + YAML loads normally with NO diagnostic", async () => {
      await lib.create(makeDef());

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const got = await lib.get("cto");
      const all = await lib.list();

      expect(got?.slug).toBe("cto");
      expect(all.map((e) => e.slug)).toEqual(["cto"]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

/**
 * #301: fileExists() in template-migration must only treat ENOENT as
 * "absent". Any other fs.access error (EACCES/EIO/EBUSY) must propagate so a
 * transient permission failure is never misclassified as a missing file —
 * which would silently route migration down the "create" branch and surface a
 * confusing downstream error. fileExists is module-private, so this lives in a
 * dedicated file that mocks node:fs/promises (ESM namespaces cannot be spied).
 *
 * #1947 (sentinel:important, security): the sibling `fs.readFile` boundary is
 * a documented load-bearing safety property (template-migration.ts:555-556 /
 * :323-327) — an fs *infrastructure* error (EACCES/EIO/ENOSPC) during a panel
 * read must PROPAGATE and abort the run, never be caught as an isolatable
 * per-panel `PanelMigrationError`. If it were swallowed, earlier panels would
 * persist rows and the next run's `isMigrationNeeded` would short-circuit
 * `false` → permanent partial-migration lock-out (#1807). This file also mocks
 * `readFile` so that invariant has an inverse-of-isolation regression test.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import { type ExpertDefinition } from "../../../src/core/expert.js";
import { migrateBuiltInTemplates } from "../../../src/core/template-migration.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = (await importOriginal()) as typeof fs;
  return { ...real, access: vi.fn(real.access), readFile: vi.fn(real.readFile) };
});

function makeExpert(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: "Valid Expert",
    role: "A schema-valid inline expert supplied by the built-in loader",
    kind: "generic",
    expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
    epistemicStance: "stance",
  };
}

describe("template-migration fileExists ENOENT narrowing (#301)", () => {
  let db: CouncilDatabase;
  let dataHome: string;
  let lib: FileExpertLibrary;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-mig-eacces-"));
    lib = new FileExpertLibrary(dataHome, db);
  });

  afterEach(async () => {
    vi.mocked(fs.access).mockRestore();
    await db.destroy();
    await fs.rm(dataHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("propagates a non-ENOENT fs.access error instead of treating the path as absent", async () => {
    const eacces = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    vi.mocked(fs.access).mockRejectedValue(eacces);

    await expect(
      migrateBuiltInTemplates(dataHome, lib, db, { quiet: true }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("template-migration fs-infra readFile error propagates + aborts (#1947)", () => {
  let db: CouncilDatabase;
  let dataHome: string;
  let lib: FileExpertLibrary;

  const stubLoader = async (
    name: string,
  ): Promise<{ name: string; experts: ExpertDefinition[] }> =>
    name === "panel-a"
      ? { name, experts: [makeExpert("alpha-expert")] }
      : { name, experts: [makeExpert("beta-expert")] };

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-mig-eio-"));
    lib = new FileExpertLibrary(dataHome, db);
  });

  afterEach(async () => {
    vi.mocked(fs.readFile).mockRestore();
    vi.mocked(fs.access).mockRestore();
    await db.destroy();
    await fs.rm(dataHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("propagates a panel-read EACCES as a raw (non-PanelMigrationError) abort and skips the later panel", async () => {
    // Seed a normal migration (real fs) so panel-a.yaml / panel-b.yaml and
    // their DB rows exist.
    await migrateBuiltInTemplates(dataHome, lib, db, {
      quiet: true,
      panelNames: ["panel-a", "panel-b"],
      loadPanel: stubLoader,
    });

    // Wipe panel rows (NOT expert rows) so the re-run enters DB-reset recovery,
    // which reads each panel file via `fs.readFile` (template-migration.ts:250)
    // — the exact boundary #1947 protects. Experts stay reuse-library (no read).
    await db.deleteFrom("panel_members").execute();
    await db.deleteFrom("panel_library").execute();

    // Make ONLY panel-a's file read fail with an fs infrastructure error;
    // everything else delegates to the real implementation so the run's other
    // fs work (and the migration lock) is untouched.
    const realFs = await vi.importActual<typeof fs>("node:fs/promises");
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const target = `${path.sep}panel-a.yaml`;
    vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string" && args[0].endsWith(target)) {
        return Promise.reject(eacces);
      }
      return realFs.readFile(...args);
    }) as typeof fs.readFile);

    let caught: unknown;
    try {
      await migrateBuiltInTemplates(dataHome, lib, db, {
        quiet: true,
        panelNames: ["panel-a", "panel-b"],
        loadPanel: stubLoader,
      });
    } catch (err) {
      caught = err;
    }

    // The infra error must PROPAGATE unchanged. A PanelMigrationError (a data
    // error) is not an instance of the raw fs error and carries no `code`, so
    // both assertions FAIL if the read were caught + reclassified as an
    // isolatable "one bad panel" failure — which is exactly the swallow bug
    // #1947 guards against.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("PanelMigrationError");
    expect(caught).toMatchObject({ code: "EACCES" });

    // Inverse of the per-panel isolation tests: because the run ABORTED at
    // panel-a rather than continuing, the alphabetically-later panel-b must NOT
    // have been re-registered. Were the infra error swallowed as isolatable,
    // panel-b's row would exist and a later isMigrationNeeded() could
    // short-circuit `false` on a partial migration (the #1807 lock-out class).
    const panelBRow = await db
      .selectFrom("panel_library")
      .selectAll()
      .where("name", "=", "panel-b")
      .executeTakeFirst();
    expect(panelBRow).toBeUndefined();
  });
});

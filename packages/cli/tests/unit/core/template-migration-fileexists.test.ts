/**
 * #301: fileExists() in template-migration must only treat ENOENT as
 * "absent". Any other fs.access error (EACCES/EIO/EBUSY) must propagate so a
 * transient permission failure is never misclassified as a missing file —
 * which would silently route migration down the "create" branch and surface a
 * confusing downstream error. fileExists is module-private, so this lives in a
 * dedicated file that mocks node:fs/promises (ESM namespaces cannot be spied).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import { migrateBuiltInTemplates } from "../../../src/core/template-migration.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = (await importOriginal()) as typeof fs;
  return { ...real, access: vi.fn(real.access) };
});

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

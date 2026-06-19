/**
 * Test helper — copy the pre-migrated template database.
 *
 * Instead of running the unified migration per test, this copies a
 * pre-built template (~5 ms) so that subsequent `createDatabase(destPath)`
 * calls find all migrations already applied.
 *
 * Usage (in test files):
 * ```ts
 * import { copyTemplateDb } from "../../helpers/template-db.js";
 *
 * beforeEach(async () => {
 *   testHome = await fs.mkdtemp(...);
 *   await copyTemplateDb(path.join(testHome, "council.db"));
 *   // createDatabase(path.join(testHome, "council.db")) is now fast
 * });
 * ```
 */
import * as fs from "node:fs/promises";

import { inject } from "vitest";

/**
 * Copy the pre-migrated template DB to `destPath`.
 *
 * Must be called from within a Vitest test context (e.g. `beforeEach`,
 * `it`, etc.) because it uses `inject()` to resolve the template path
 * provided by `tests/global-setup.ts`.
 *
 * Removes any stale destination files (`.db`, `-wal`, `-shm`) before
 * copying to avoid Windows EPERM errors from leftover handles.
 */
export async function copyTemplateDb(destPath: string): Promise<void> {
  const templatePath = inject("templateDbPath");

  // Clean up any stale destination files from a previous test.
  for (const filePath of [destPath, `${destPath}-wal`, `${destPath}-shm`]) {
    try {
      await fs.unlink(filePath);
    } catch {
      /* file doesn't exist — fine */
    }
  }

  await fs.copyFile(templatePath, destPath);
}

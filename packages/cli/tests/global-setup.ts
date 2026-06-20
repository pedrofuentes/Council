/**
 * Vitest global setup — pre-migrated template DB.
 *
 * Creates a single, fully-migrated SQLite database file before any test
 * worker starts.  Workers copy this template (via `copyTemplateDb()` in
 * `tests/helpers/template-db.ts`) instead of running the migration per
 * `createDatabase()` call.
 *
 * Impact: each DB creation is ~5 ms (`fs.copyFile` of a ~50 KB template).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TestProject } from "vitest/node";

import { loadMigrations, splitSqlStatements } from "../src/memory/db.js";

const SQLITE_BUSY_TIMEOUT_MS = 5000;

let templateDir: string | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-template-"));
  const templatePath = path.join(templateDir, "council.db");

  const database = new DatabaseSync(templatePath);

  try {
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    database.exec("PRAGMA journal_mode = WAL;");

    // Apply all migrations (replicates applyMigrations using exported helpers).
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );

    for (const migration of loadMigrations()) {
      database.exec("BEGIN IMMEDIATE;");
      const existing = database
        .prepare("SELECT version FROM schema_version WHERE version = ?;")
        .get(migration.version);

      if (existing) {
        database.exec("COMMIT;");
        continue;
      }

      for (const stmt of splitSqlStatements(migration.sql)) {
        database.exec(stmt);
      }

      database
        .prepare(
          "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?);",
        )
        .run(migration.version, new Date().toISOString());
      database.exec("COMMIT;");
    }

    // Seal: consolidate WAL into the main file and switch to DELETE journal
    // mode so the template is a single, self-contained .db file.
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get() as
      | { readonly busy?: number }
      | undefined;
    const busy = Number(checkpoint?.busy ?? -1);
    if (busy !== 0) {
      throw new Error(`WAL checkpoint failed: busy=${busy} (expected 0)`);
    }

    database.exec("PRAGMA journal_mode = DELETE;");
  } finally {
    // Explicitly close the handle so the file is released.
    database.close();
  }

  // Remove any leftover sidecar files (should not exist after DELETE mode).
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(templatePath + suffix);
    } catch {
      /* already gone — fine */
    }
  }

  // Validate: reopen and check migration count.
  const verifyDb = new DatabaseSync(templatePath);
  try {
    const result = verifyDb
      .prepare("SELECT COUNT(*) AS cnt FROM schema_version;")
      .get() as { readonly cnt?: number } | undefined;
    const count = Number(result?.cnt ?? 0);
    const expected = loadMigrations().length;
    if (count !== expected) {
      throw new Error(
        `Template DB has ${count} migrations, expected ${expected}`,
      );
    }
  } finally {
    verifyDb.close();
  }

  project.provide("templateDbPath", templatePath);

  return async () => {
    if (templateDir) {
      try {
        fs.rmSync(templateDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };
}

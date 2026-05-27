/**
 * Vitest global setup — pre-migrated template DB.
 *
 * Creates a single, fully-migrated SQLite database file before any test
 * worker starts.  Workers copy this template (via `copyTemplateDb()` in
 * `tests/helpers/template-db.ts`) instead of running 11 sequential
 * migrations per `createDatabase()` call.
 *
 * Impact: each DB creation drops from ~5 s (11 migrations + file I/O on
 * Windows) to ~5 ms (`fs.copyFile` of a ~50 KB template).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely } from "kysely";
import type { TestProject } from "vitest/node";

import {
  loadMigrations,
  splitSqlStatements,
  type CouncilSchema,
} from "../src/memory/db.js";

const SQLITE_BUSY_TIMEOUT_MS = 5000;

let templateDir: string | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-template-"));
  const templatePath = path.join(templateDir, "council.db");

  // We manage the client directly (instead of using `createDatabase()`)
  // because `LibsqlDialect({ client })` sets `closeClient = false`,
  // meaning `db.destroy()` would NOT close the underlying libsql
  // client — leaking a file handle on Windows.
  const client = createClient({ url: `file:${templatePath}` });

  try {
    await client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    await client.execute("PRAGMA journal_mode = WAL;");

    const dialect = new LibsqlDialect({ client });
    const db = new Kysely<CouncilSchema>({ dialect });

    // Apply all migrations (replicates applyMigrations using exported helpers).
    await client.execute(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );

    for (const migration of loadMigrations()) {
      await client.execute("BEGIN IMMEDIATE;");
      const existing = await db
        .selectFrom("schema_version")
        .select("version")
        .where("version", "=", migration.version)
        .executeTakeFirst();

      if (existing) {
        await client.execute("COMMIT;");
        continue;
      }

      for (const stmt of splitSqlStatements(migration.sql)) {
        await client.execute(stmt);
      }

      await db
        .insertInto("schema_version")
        .values({
          version: migration.version,
          applied_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column("version").doNothing())
        .execute();
      await client.execute("COMMIT;");
    }

    // Seal: consolidate WAL into main file and switch to DELETE journal
    // mode so the template is a single, self-contained .db file.
    const checkpoint = await client.execute("PRAGMA wal_checkpoint(TRUNCATE);");
    const busy = Number(checkpoint.rows[0]?.busy ?? -1);
    if (busy !== 0) {
      throw new Error(`WAL checkpoint failed: busy=${busy} (expected 0)`);
    }

    await client.execute("PRAGMA journal_mode = DELETE;");

    // Destroy Kysely (does not close the client — see note above).
    await db.destroy();
  } finally {
    // Explicitly close the client so the file handle is released.
    client.close();
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
  const verifyClient = createClient({ url: `file:${templatePath}` });
  try {
    const result = await verifyClient.execute("SELECT COUNT(*) AS cnt FROM schema_version;");
    const count = Number(result.rows[0]?.cnt ?? 0);
    const expected = loadMigrations().length;
    if (count !== expected) {
      throw new Error(
        `Template DB has ${count} migrations, expected ${expected}`,
      );
    }
  } finally {
    verifyClient.close();
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

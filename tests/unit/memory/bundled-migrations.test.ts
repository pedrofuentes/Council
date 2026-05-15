/**
 * Regression test for issue #492 (follow-up to PR #486).
 *
 * The bundled CLI artifact (tsup single-file output in dist/) does not ship
 * the src/memory/migrations/*.sql files. Migrations must therefore be inlined
 * as string literals in src/memory/db.ts so that `createDatabase` works at
 * runtime without filesystem access to .sql files.
 *
 * This test fails if anyone reintroduces a `fs.readFileSync` (or async
 * equivalent) call on a `.sql` path during `createDatabase`, OR if the
 * migration runner module starts importing/reading external .sql files.
 */
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DB_MODULE_PATH = path.join(REPO_ROOT, "src", "memory", "db.ts");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "src", "memory", "migrations");

describe("bundled migrations (issue #492)", () => {
  it("src/memory/db.ts does not import or read .sql files at runtime", async () => {
    const dbSource = await readFile(DB_MODULE_PATH, "utf8");

    // The bundled CLI ships only dist/index.js — no .sql files travel with it.
    // db.ts must therefore neither import nor read any .sql file.
    expect(dbSource, "db.ts must not call readFileSync on a .sql path").not.toMatch(
      /readFileSync\s*\([^)]*\.sql/,
    );
    expect(dbSource, "db.ts must not call readFile on a .sql path").not.toMatch(
      /\breadFile\s*\([^)]*\.sql/,
    );
    expect(dbSource, "db.ts must not import a .sql file").not.toMatch(
      /import\s+[^;]*['"][^'"]*\.sql['"]/,
    );
    expect(dbSource, "db.ts must not require a .sql file").not.toMatch(
      /require\s*\(\s*['"][^'"]*\.sql['"]\s*\)/,
    );

    // Stronger invariant: the migration runner module currently has no
    // reason to touch the filesystem at all. If this changes, the author
    // must justify it — and update this test deliberately.
    expect(dbSource, "db.ts must not import node:fs (migrations are inlined)").not.toMatch(
      /from\s+['"]node:fs(?:\/promises)?['"]/,
    );
    expect(dbSource, "db.ts must not import node:path (migrations are inlined)").not.toMatch(
      /from\s+['"]node:path['"]/,
    );
  });

  it("every canonical .sql file has an inlined counterpart in db.ts", async () => {
    const [dbSource, entries] = await Promise.all([
      readFile(DB_MODULE_PATH, "utf8"),
      readdir(MIGRATIONS_DIR),
    ]);
    const migrationFiles = entries.filter((f) => f.endsWith(".sql")).sort();
    expect(migrationFiles.length).toBeGreaterThan(0);

    for (const file of migrationFiles) {
      const name = file.replace(/\.sql$/, "");
      expect(
        dbSource.includes(`"${name}"`),
        `db.ts is missing inlined migration entry name: "${name}" (file ${file})`,
      ).toBe(true);
    }
  });
});

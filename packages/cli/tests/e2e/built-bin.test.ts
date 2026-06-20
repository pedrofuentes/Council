import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Smoke test for the **bundled** CLI (`dist/bin/council.js`), not the source.
 *
 * The rest of the e2e suite imports command builders from `src/` and runs them
 * in-process, so it never exercises tsup's esbuild output. esbuild strips the
 * mandatory `node:` prefix from `node:sqlite` (Node has no bare `sqlite`
 * builtin), which crashed the published binary at startup with
 * `Cannot find package 'sqlite'`. This test builds the package and runs the
 * real bundled binary so that regression is caught in CI.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const binPath = path.join(pkgRoot, "dist", "bin", "council.js");

describe("bundled CLI binary", () => {
  beforeAll(() => {
    execSync("pnpm run build", { cwd: pkgRoot, stdio: "pipe" });
  }, 180_000);

  it("runs `doctor --offline` from dist (node:sqlite resolves in the bundle)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "council-built-bin-"));
    try {
      const stdout = execFileSync(process.execPath, [binPath, "doctor", "--offline"], {
        encoding: "utf8",
        env: { ...process.env, COUNCIL_DATA_HOME: home },
      });

      expect(stdout).toContain("SQLite (node:sqlite)");
      expect(stdout).toContain("All checks passed");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Meta-test for the ClusterFuzzLite fuzz-engine pin (issue #1542,
 * sentinel:important).
 *
 * `.clusterfuzzlite/build.sh` no longer runs an ad-hoc, integrity-unverified
 * `npm install @jazzer.js/core@2.1.0` into a throwaway dir with no lockfile. It
 * now installs the engine with `npm ci` from the committed lockfile in
 * `.clusterfuzzlite/jazzer/`, so every package is verified against a sha512
 * hash and the build aborts on any mismatch.
 *
 * The `2.1.0` pin is DELIBERATE: its prebuilt native addon links glibc 2.31
 * (the OSS-Fuzz base image's floor); Jazzer.js 4.x needs GLIBC_2.32 and fails
 * to `dlopen` on that base. See `.clusterfuzzlite/README.md`.
 *
 * This test is hermetic (no npm, no network): it reads the two committed files
 * and asserts the invariants a future edit — e.g. a careless lockfile regen or
 * a version bump that ignores the glibc constraint — must never break:
 *   (a) package.json is private and pins @jazzer.js/core to EXACTLY 2.1.0 (no
 *       caret / tilde / range that could float off the glibc-safe version),
 *   (b) the lockfile pins @jazzer.js/core to 2.1.0 with a sha512 integrity hash,
 *   (c) EVERY registry package in the lockfile carries a sha512 integrity hash,
 *       so the whole transitive tree — not just the root dep — is verified.
 *
 * RED before the fix: `.clusterfuzzlite/jazzer/` does not exist yet, so reading
 * package.json throws and the existence assertion fails.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentFile = fileURLToPath(import.meta.url);
// packages/cli/tests/unit/ci -> repo root is five levels up.
const REPO_ROOT = path.resolve(path.dirname(currentFile), "../../../../..");
const JAZZER_DIR = path.join(REPO_ROOT, ".clusterfuzzlite", "jazzer");
const PACKAGE_JSON_PATH = path.join(JAZZER_DIR, "package.json");
const LOCKFILE_PATH = path.join(JAZZER_DIR, "package-lock.json");

const JAZZER_CORE = "@jazzer.js/core";
const PINNED_VERSION = "2.1.0";

interface JazzerPackageJson {
  readonly private?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface LockfilePackage {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
}

interface Lockfile {
  readonly lockfileVersion?: number;
  readonly packages?: Record<string, LockfilePackage>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

describe("ClusterFuzzLite jazzer engine pin (issue #1542)", () => {
  it("commits both a package.json and a package-lock.json for the engine", () => {
    expect(existsSync(PACKAGE_JSON_PATH)).toBe(true);
    expect(existsSync(LOCKFILE_PATH)).toBe(true);
  });

  it("pins @jazzer.js/core to EXACTLY 2.1.0 in a private package.json", () => {
    const pkg = readJson<JazzerPackageJson>(PACKAGE_JSON_PATH);
    expect(pkg.private).toBe(true);
    const spec = { ...pkg.devDependencies, ...pkg.dependencies }[JAZZER_CORE];
    expect(spec, `${JAZZER_CORE} must be declared`).toBeDefined();
    // Exact pin only: reject caret/tilde/range/wildcard so the glibc-2.31-safe
    // build can never float to a version whose prebuilt needs a newer glibc.
    expect(spec).toBe(PINNED_VERSION);
  });

  it("locks @jazzer.js/core at 2.1.0 with a sha512 integrity hash", () => {
    const lock = readJson<Lockfile>(LOCKFILE_PATH);
    // lockfileVersion >= 2 is what carries per-package `integrity` hashes.
    expect(lock.lockfileVersion ?? 0).toBeGreaterThanOrEqual(2);
    const core = lock.packages?.[`node_modules/${JAZZER_CORE}`];
    expect(core, `lockfile must contain ${JAZZER_CORE}`).toBeDefined();
    expect(core?.version).toBe(PINNED_VERSION);
    expect(core?.resolved).toContain(`/${JAZZER_CORE}/`);
    expect(core?.integrity).toMatch(/^sha512-/);
  });

  it("integrity-verifies every resolved package in the transitive tree", () => {
    const lock = readJson<Lockfile>(LOCKFILE_PATH);
    const entries = Object.entries(lock.packages ?? {});
    // Sanity: Jazzer.js pulls a large tree, so this must not be near-empty
    // (a truncated lockfile would otherwise vacuously "pass" the check below).
    expect(entries.length).toBeGreaterThan(1);
    const withoutIntegrity = entries
      .filter(([name, meta]) => {
        if (name === "") return false; // the root project has no integrity hash
        if (meta.link) return false; // local symlinks carry no integrity hash
        return !meta.integrity?.startsWith("sha512-");
      })
      .map(([name]) => name);
    expect(
      withoutIntegrity,
      "every registry package in the lockfile must carry a sha512 integrity hash",
    ).toEqual([]);
  });
});

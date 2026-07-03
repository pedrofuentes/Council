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
 *       so the whole transitive tree — not just the root dep — is verified,
 *   (d) `build.sh` actually consumes that committed lockfile: it copies BOTH
 *       `.clusterfuzzlite/jazzer/package.json` and `package-lock.json` into its
 *       install dir and installs the engine with `npm ci` (a lockfile-driven,
 *       integrity-verifying install) — never with an ad-hoc
 *       `npm install --no-save @jazzer.js/core@…` that would bypass the
 *       committed lockfile and silently re-open the #1542 integrity gap,
 *   (e) the lockfile is a COMPLETE dependency closure, not a truncated stub:
 *       it pins a realistic number of packages and every runtime dependency
 *       @jazzer.js/core declares resolves to a pinned, integrity-hashed entry.
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
const BUILD_SH_PATH = path.join(REPO_ROOT, ".clusterfuzzlite", "build.sh");

const JAZZER_CORE = "@jazzer.js/core";
const PINNED_VERSION = "2.1.0";

// Jazzer.js 2.1.0 resolves to a large transitive tree (177 packages at the time
// this pin was committed). A truncated or root+core-only stub would defeat the
// integrity guarantee, so require a realistic floor well above such stubs while
// still leaving generous headroom for future minor lockfile churn.
const MIN_LOCKFILE_PACKAGES = 100;

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
  readonly dependencies?: Record<string, string>;
}

interface Lockfile {
  readonly lockfileVersion?: number;
  readonly packages?: Record<string, LockfilePackage>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

/**
 * Resolve a dependency `dep` required by the package installed at `fromPath`
 * (a `packages` key like `node_modules/@jazzer.js/core`) using npm's nested
 * node_modules resolution: walk up the directory chain, checking a co-located
 * `node_modules/<dep>` at each level before falling back to the tree root.
 */
function resolveLockfileDep(
  packages: Record<string, LockfilePackage>,
  fromPath: string,
  dep: string,
): LockfilePackage | undefined {
  let prefix = fromPath;
  for (;;) {
    const candidate = prefix === "" ? `node_modules/${dep}` : `${prefix}/node_modules/${dep}`;
    const entry = packages[candidate];
    if (entry) return entry;
    if (prefix === "") return undefined;
    const cut = prefix.lastIndexOf("/node_modules/");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
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
    const withoutIntegrity = entries
      .filter(([name, meta]) => {
        if (name === "") return false; // the root project has no integrity hash
        if (meta.link) return false; // local symlinks carry no integrity hash
        // Every entry that resolved to a registry tarball MUST carry a hash;
        // entries with no `resolved` (e.g. workspace stubs) have nothing to
        // verify. Guard both: a resolved-but-unhashed entry is a hole.
        if (!meta.resolved) return false;
        return !meta.integrity?.startsWith("sha512-");
      })
      .map(([name]) => name);
    expect(
      withoutIntegrity,
      "every registry package in the lockfile must carry a sha512 integrity hash",
    ).toEqual([]);
  });

  it("pins a COMPLETE dependency closure, not a truncated lockfile stub", () => {
    const lock = readJson<Lockfile>(LOCKFILE_PATH);
    const packages = lock.packages ?? {};
    const entries = Object.entries(packages);

    // (1) Realistic lower bound: a root+core-only (or otherwise gutted)
    //     lockfile would sail past the old `> 1` guard but must fail here.
    expect(
      entries.length,
      `lockfile pins only ${entries.length} packages; a complete @jazzer.js/core ` +
        `${PINNED_VERSION} closure is far larger — this looks truncated`,
    ).toBeGreaterThanOrEqual(MIN_LOCKFILE_PACKAGES);

    // (2) Every runtime dependency @jazzer.js/core DECLARES must itself resolve
    //     to a pinned, integrity-hashed entry. A truncation that drops core's
    //     own deps (e.g. the sibling @jazzer.js/* packages) fails here.
    const corePath = `node_modules/${JAZZER_CORE}`;
    const core = packages[corePath];
    expect(core, `lockfile must contain ${JAZZER_CORE}`).toBeDefined();
    const declaredDeps = Object.keys(core?.dependencies ?? {});
    expect(
      declaredDeps.length,
      `${JAZZER_CORE} must declare its runtime dependencies in the lockfile`,
    ).toBeGreaterThan(0);

    const unresolved: string[] = [];
    for (const dep of declaredDeps) {
      const resolved = resolveLockfileDep(packages, corePath, dep);
      if (!resolved || !resolved.integrity?.startsWith("sha512-")) {
        unresolved.push(dep);
      }
    }
    expect(
      unresolved,
      `every dependency ${JAZZER_CORE} declares must be pinned with a sha512 ` +
        `integrity hash; missing/unhashed: ${unresolved.join(", ")}`,
    ).toEqual([]);
  });

  it("installs the engine via `npm ci` from the committed lockfile in build.sh", () => {
    expect(existsSync(BUILD_SH_PATH), "build.sh must exist").toBe(true);
    const buildSh = readFileSync(BUILD_SH_PATH, "utf8");

    // (1) build.sh must copy BOTH committed jazzer files into its install dir,
    //     so the install is driven by the integrity-verified lockfile.
    expect(
      buildSh,
      "build.sh must copy the committed jazzer package.json into its install dir",
    ).toContain(".clusterfuzzlite/jazzer/package.json");
    expect(
      buildSh,
      "build.sh must copy the committed jazzer package-lock.json into its install dir",
    ).toContain(".clusterfuzzlite/jazzer/package-lock.json");

    // (2) The engine install MUST be `npm ci` (lockfile-driven, integrity
    //     verifying), asserted as a literal invocation.
    expect(
      /\bnpm ci\b/.test(buildSh),
      "build.sh must install Jazzer.js with `npm ci` from the committed lockfile",
    ).toBe(true);

    // (3) It MUST NOT fall back to an ad-hoc, lockfile-bypassing install of the
    //     engine. A revert to `npm install --no-save @jazzer.js/core@2.1.0`
    //     (the #1542 regression) must make THIS assertion fail. We reject any
    //     `npm install ... @jazzer.js/core ...` and any `--no-save` install
    //     referencing the core package, regardless of arg order.
    const npmInstallLines = buildSh.split("\n").filter((line) => /\bnpm install\b/.test(line));
    const adHocEngineInstall = npmInstallLines.filter((line) => line.includes(JAZZER_CORE));
    expect(
      adHocEngineInstall,
      "build.sh must NOT install @jazzer.js/core via `npm install` (bypasses " +
        "the committed, integrity-verified lockfile — the #1542 regression)",
    ).toEqual([]);
    const noSaveEngineInstall = npmInstallLines.filter(
      (line) => line.includes("--no-save") && line.includes(JAZZER_CORE),
    );
    expect(
      noSaveEngineInstall,
      "build.sh must NOT install @jazzer.js/core via `npm install --no-save`",
    ).toEqual([]);
  });
});

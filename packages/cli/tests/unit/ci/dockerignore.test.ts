/**
 * Meta-test for the repo-root `.dockerignore` (issue #1543,
 * sentinel:important + sentinel:security).
 *
 * `.clusterfuzzlite/Dockerfile` builds with the context rooted at the repo root
 * and does `COPY . $SRC/council`. Without a repo-root `.dockerignore`, that copy
 * bakes the entire tree — `.git` history, local `.env`/secret material, Council
 * SQLite databases, editor/OS junk, `.worktrees/`, and build output — into the
 * published fuzz image (secret-exposure + bloat). A `.dockerignore` read from the
 * build-context root fixes this.
 *
 * This test is hermetic (no Docker, no network): it reads the committed
 * `.dockerignore` and asserts two invariants that a future edit must never break:
 *   (a) the critical deny patterns are present, and
 *   (b) NONE of the paths the ClusterFuzzLite build actually compiles from are
 *       ignored — so the fix can never silently starve the fuzz build.
 *
 * The required-input list is derived from `.clusterfuzzlite/build.sh` +
 * `.clusterfuzzlite/tsconfig.fuzz.json`:
 *   - build.sh reads the ROOT `package.json` for the pinned tsc version, runs
 *     `tsc -p .clusterfuzzlite/tsconfig.fuzz.json`, and loops `.clusterfuzzlite/fuzz_*.js`.
 *   - tsconfig.fuzz.json transpiles packages/cli/src/cli/{strip-control-chars,
 *     hidden-format-chars}.ts.
 * (node_modules is intentionally NOT required: build.sh installs typescript and
 *  Jazzer.js into isolated temp dirs and never uses committed node_modules.)
 *
 * RED before the fix: `.dockerignore` does not exist yet, so reading it throws
 * and the existence assertion fails.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/cli/tests/unit/ci -> repo root is five levels up.
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DOCKERIGNORE_PATH = path.join(REPO_ROOT, ".dockerignore");

/** Parse a `.dockerignore` into its non-comment, non-empty pattern lines. */
function parsePatterns(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Convert a single `.dockerignore` pattern into a RegExp using Docker/moby
 * (`patternmatcher`) semantics for the subset this repo uses:
 *   - `*`  matches any run of non-`/` chars,
 *   - `?`  matches a single non-`/` char,
 *   - `**` (optionally followed by a slash) matches any number of path
 *     segments including zero, so a `**` prefix also matches a root-level entry,
 *   - all other characters are literal (regex metachars are escaped).
 */
function patternToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i += 2; // consume '**'
      if (pattern[i] === "/") i += 1; // consume the slash after '**'
      re += i >= n ? ".*" : "(.*/)?";
      continue;
    }
    if (c === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += ".$+(){}|^[]\\".includes(c) ? `\\${c}` : c;
    i += 1;
  }
  re += "$";
  return new RegExp(re);
}

/** Every ancestor directory path of a file, e.g. `a/b/c.ts` -> ["a", "a/b"]. */
function ancestorDirs(filePath: string): string[] {
  const segments = filePath.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    ancestors.push(segments.slice(0, i).join("/"));
  }
  return ancestors;
}

function cleanPattern(raw: string): string {
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Docker-context ignore evaluation: a path is ignored when the last pattern to
 * match it (the file itself or any ancestor directory) is non-negated. A `!`
 * prefix re-includes (last match wins), mirroring moby's `Matches`.
 */
function isIgnored(patterns: string[], filePath: string): boolean {
  const prefixes = [filePath, ...ancestorDirs(filePath)];
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const cleaned = cleanPattern(negated ? raw.slice(1) : raw);
    if (cleaned.length === 0) continue;
    const re = patternToRegExp(cleaned);
    if (prefixes.some((candidate) => re.test(candidate))) {
      ignored = !negated;
    }
  }
  return ignored;
}

// Patterns that MUST be present so secrets / VCS / bulk never enter the image.
const CRITICAL_DENY_PATTERNS = [
  ".git",
  "**/node_modules",
  ".worktrees",
  "**/dist",
  "**/coverage",
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "**/.DS_Store",
  "**/*.db",
  ".council",
];

// Paths the ClusterFuzzLite build compiles from — none may be ignored.
const REQUIRED_BUILD_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".clusterfuzzlite/build.sh",
  ".clusterfuzzlite/tsconfig.fuzz.json",
  ".clusterfuzzlite/package.json",
  ".clusterfuzzlite/fuzz_strip_control_chars.js",
  "packages/cli/package.json",
  "packages/cli/src/cli/strip-control-chars.ts",
  "packages/cli/src/cli/hidden-format-chars.ts",
];

describe("repo-root .dockerignore (issue #1543)", () => {
  it("exists at the repo root (build-context root)", () => {
    expect(existsSync(DOCKERIGNORE_PATH)).toBe(true);
  });

  it("excludes the critical secret / VCS / bulk patterns", () => {
    const patterns = parsePatterns(readFileSync(DOCKERIGNORE_PATH, "utf8"));
    for (const deny of CRITICAL_DENY_PATTERNS) {
      expect(patterns, `expected .dockerignore to contain "${deny}"`).toContain(deny);
    }
  });

  it("actually ignores sensitive / bulky paths", () => {
    const patterns = parsePatterns(readFileSync(DOCKERIGNORE_PATH, "utf8"));
    const shouldBeIgnored = [
      ".git/config",
      "packages/cli/node_modules/typescript/package.json",
      "packages/cli/dist/index.js",
      ".env",
      ".env.local",
      "config/service-account.key",
      "certs/server.pem",
      ".council/council.db",
      "packages/cli/data.db",
      ".DS_Store",
      "packages/cli/.DS_Store",
      ".worktrees/fix-1543/secret.txt",
      "debug.log",
    ];
    for (const target of shouldBeIgnored) {
      expect(isIgnored(patterns, target), `expected "${target}" to be ignored`).toBe(true);
    }
  });

  it("does NOT ignore any input the ClusterFuzzLite build compiles from", () => {
    const patterns = parsePatterns(readFileSync(DOCKERIGNORE_PATH, "utf8"));
    for (const input of REQUIRED_BUILD_INPUTS) {
      expect(isIgnored(patterns, input), `.dockerignore must not ignore "${input}"`).toBe(false);
    }
  });

  it("is a deny-list, not a `*` allow-list that could drop build inputs", () => {
    const patterns = parsePatterns(readFileSync(DOCKERIGNORE_PATH, "utf8"));
    // A bare `*` / `**` catch-all would ignore everything and rely on fragile
    // re-includes; the required-input guard above must not depend on that.
    expect(patterns).not.toContain("*");
    expect(patterns).not.toContain("**");
  });
});

describe("dockerignore matcher (test-helper self-validation)", () => {
  it("treats a `*` catch-all as ignoring a required build input", () => {
    // Proves the required-input guard has teeth: an over-broad rule is caught.
    expect(isIgnored(["*"], "package.json")).toBe(true);
    expect(isIgnored(["packages"], "packages/cli/src/cli/strip-control-chars.ts")).toBe(true);
  });

  it("matches `**/x` at the root and at any depth, but not siblings", () => {
    expect(isIgnored(["**/node_modules"], "node_modules/x")).toBe(true);
    expect(isIgnored(["**/node_modules"], "packages/cli/node_modules/x")).toBe(true);
    expect(isIgnored(["**/node_modules"], "packages/cli/package.json")).toBe(false);
    // `**/dist` must not match the sibling `dist-fuzz` name.
    expect(isIgnored(["**/dist"], "packages/cli/dist-fuzz/x.js")).toBe(false);
  });

  it("ignores a whole directory tree once its name matches", () => {
    expect(isIgnored([".git"], ".git")).toBe(true);
    expect(isIgnored([".git"], ".git/hooks/pre-commit")).toBe(true);
    // `.git` must not accidentally swallow the distinct `.gitignore` file.
    expect(isIgnored([".git"], ".gitignore")).toBe(false);
  });

  it("honours last-match-wins negation (`!`)", () => {
    expect(isIgnored(["*.log"], "debug.log")).toBe(true);
    expect(isIgnored(["*.log", "!keep.log"], "keep.log")).toBe(false);
    expect(isIgnored(["*.log", "!keep.log"], "debug.log")).toBe(true);
  });

  it("respects `**/*.ext` extension globs across depth without over-matching", () => {
    expect(isIgnored(["**/*.db"], "x.db")).toBe(true);
    expect(isIgnored(["**/*.db"], ".council/council.db")).toBe(true);
    expect(isIgnored(["**/*.db"], "packages/cli/package.json")).toBe(false);
    expect(isIgnored([".env.*"], ".env.production")).toBe(true);
    expect(isIgnored([".env.*"], ".environment")).toBe(false);
  });
});

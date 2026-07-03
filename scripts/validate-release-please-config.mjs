#!/usr/bin/env node
/**
 * validate-release-please-config.mjs
 *
 * PR-time guard (issue #623) that validates `release-please-config.json` and
 * `.release-please-manifest.json` against release-please-action v5
 * (release-please core v17) BEFORE merge. The Release workflow
 * (.github/workflows/release-please.yml) only runs post-merge on `main`
 * (`on: push: branches: [main]`), so without this guard a config/manifest that
 * v5 rejects would only fail AFTER it has already landed on `main`.
 *
 * Uses only Node.js built-ins (node:fs, node:path, node:url, node:process) — no
 * npm dependencies and no third-party GitHub Actions.
 *
 * The allowlists below are derived from the release-please v17 TypeScript source
 * of truth, NOT the published JSON schema (the schema omits accepted keys such
 * as `component`, so a schema-only check would false-positive on the real
 * config):
 *   - release types  -> src/factory.ts `releasers` registry
 *     https://github.com/googleapis/release-please/blob/v17.1.1/src/factory.ts
 *   - config keys    -> src/manifest.ts `ReleaserConfigJson`,
 *     `ReleaserPackageConfig`, `ManifestConfig`
 *     https://github.com/googleapis/release-please/blob/v17.1.1/src/manifest.ts
 * When bumping `googleapis/release-please-action`, re-derive these from the
 * matching release-please core tag.
 *
 * Usage:
 *   node scripts/validate-release-please-config.mjs [configPath] [manifestPath]
 *
 * Exits 0 when the config/manifest is valid; prints each problem and exits 1
 * otherwise.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --- Terminal-safe display sanitizer -----------------------------------------
//
// This validator reads attacker-controllable JSON — a fork `pull_request` can
// edit `release-please-config.json` / `.release-please-manifest.json` — and
// echoes offending keys/values (and, on a read/parse failure, the path and the
// JSON parser's message) to the Actions log. Untrusted control/escape bytes in
// that text could spoof log lines or manipulate the terminal (OSC title /
// clipboard / cursor) when raw logs are viewed. Every DISPLAYED fragment is
// therefore sanitized; the RAW values still drive every validity decision.
//
// Self-contained mirror of the repo's canonical `toSingleLineDisplay` in
// packages/cli/src/cli/strip-control-chars.ts (and of the identical mirror in
// scripts/verify-action-pins.mjs) — this standalone Node ESM script cannot
// import from packages/cli. Keep the three in sync.

// Order matters: match the multi-char ANSI/OSC/DCS sequences BEFORE the C0
// character class, otherwise the class would consume the leading ESC (\x1B is
// in the \x0E-\x1F range) and leave the sequence body visible. Every branch is
// non-backtracking (negated classes / disjoint ranges) so unterminated
// introducers sanitize in linear time (ReDoS guard). Branches, in order:
//   - CSI:            ESC [ ... final byte (private/intermediate bytes allowed)
//   - OSC:            ESC ] ... (BEL | ST), optional terminator
//   - DCS/SOS/PM/APC: ESC (P|X|^|_) ... ST, optional terminator
//   - C0 (except TAB/LF/CR) + DEL + C1 controls
//   - strong bidi override/isolate controls
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN =
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?|\x1B[P^_X][^\x1B]*(?:\x1B\\)?|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]|[\u202A-\u202E\u2066-\u2069]/gs;

/** Zero-width characters (invisible; usable for obfuscation/injection). */
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF]/g;

/** Weak Bidi_Control marks and hidden default-ignorable format characters. */
const HIDDEN_FORMAT_CHARS =
  /[\u00AD\u061C\u115F\u1160\u200E\u200F\u2060-\u2064\u3164\uFFA0\u{E0000}-\u{E007F}]/gu;

/**
 * Sanitize untrusted text for single-line display in CI logs. Strips ANSI
 * CSI/OSC/DCS/SOS/PM/APC escape sequences, C0 (except TAB/LF/CR), DEL and C1
 * controls, strong bidi controls, and zero-width/hidden format characters, then
 * folds any surviving CR/LF/TAB/U+2028/U+2029 run to a single space so the
 * result always renders on one line. Display-only: callers keep validating and
 * comparing the RAW value.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function toSingleLineDisplay(text) {
  return String(text)
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(ZERO_WIDTH_CHARS, "")
    .replace(HIDDEN_FORMAT_CHARS, "")
    .replace(/[\r\n\t\u2028\u2029]+/g, " ");
}

/**
 * True when `candidatePath` resolves to `rootPath` itself or a location nested
 * under it. Confines the validator's config/manifest paths to the repo root
 * (defense-in-depth, issue #2181 item 7): a supplied path must not escape via
 * `..`, an absolute path, or a sibling-prefix look-alike — "/repo-evil" is NOT
 * under "/repo".
 *
 * @param {string} candidatePath
 * @param {string} rootPath
 * @returns {boolean}
 */
export function isPathWithinRoot(candidatePath, rootPath) {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(rootWithSep);
}

/**
 * Release strategies release-please v17 registers (src/factory.ts `releasers`).
 * A `release-type` outside this set makes release-please throw
 * "Unknown release type: <x>" at runtime.
 */
export const KNOWN_RELEASE_TYPES = new Set([
  "bazel",
  "dart",
  "dotnet-yoshi",
  "elixir",
  "expo",
  "go",
  "go-yoshi",
  "helm",
  "java",
  "java-backport",
  "java-bom",
  "java-lts",
  "java-yoshi",
  "java-yoshi-mono-repo",
  "krm-blueprint",
  "maven",
  "node",
  "ocaml",
  "php",
  "php-yoshi",
  "python",
  "r",
  "ruby",
  "ruby-yoshi",
  "rust",
  "salesforce",
  "sfdx",
  "simple",
  "terraform-module",
]);

/**
 * Keys accepted inside a per-package config object:
 * `ReleaserConfigJson` + `ReleaserPackageConfig` (src/manifest.ts).
 */
export const KNOWN_PACKAGE_KEYS = new Set([
  // ReleaserConfigJson
  "release-type",
  "versioning",
  "bump-minor-pre-major",
  "bump-patch-for-minor-pre-major",
  "prerelease-type",
  "changelog-sections",
  "release-as",
  "skip-github-release",
  "skip-changelog",
  "draft",
  "prerelease",
  "draft-pull-request",
  "label",
  "release-label",
  "extra-label",
  "include-component-in-tag",
  "include-v-in-tag",
  "changelog-type",
  "changelog-host",
  "pull-request-title-pattern",
  "pull-request-header",
  "pull-request-footer",
  "component-no-space",
  "separate-pull-requests",
  "tag-separator",
  "extra-files",
  "version-file",
  "snapshot-label",
  "skip-snapshot",
  "initial-version",
  "exclude-paths",
  "date-format",
  // ReleaserPackageConfig extras
  "package-name",
  "component",
  "changelog-path",
]);

/**
 * Keys accepted at the top level of the manifest config: `ManifestConfig`
 * (src/manifest.ts) plus every per-package key (release-please reads them from
 * the root as inherited defaults) plus `$schema` (a JSON-schema pointer that
 * release-please ignores but the repo config sets).
 */
export const KNOWN_ROOT_KEYS = new Set([
  ...KNOWN_PACKAGE_KEYS,
  "$schema",
  "packages",
  "bootstrap-sha",
  "last-release-sha",
  "always-link-local",
  "plugins",
  "signoff",
  "group-pull-request-title-pattern",
  "release-search-depth",
  "commit-search-depth",
  "sequential-calls",
  "always-update",
]);

// Official SemVer 2.0.0 grammar (https://semver.org). release-please parses each
// manifest version with `Version.parse`, which rejects anything non-semver.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is a valid SemVer 2.0.0 string.
 */
export function isValidSemver(value) {
  return typeof value === "string" && SEMVER_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is a non-null, non-array object.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed release-please config + manifest against v5 (core v17).
 *
 * @param {unknown} config   Parsed release-please-config.json.
 * @param {unknown} manifest Parsed .release-please-manifest.json.
 * @returns {{ ok: boolean, errors: string[] }} `ok` is true only when `errors`
 *   is empty. All discovered problems are accumulated (the function never
 *   throws on malformed input).
 */
export function validateReleasePleaseConfig(config, manifest) {
  const errors = [];

  if (!isPlainObject(config)) {
    errors.push("release-please-config.json must be a JSON object.");
  }
  if (!isPlainObject(manifest)) {
    errors.push(".release-please-manifest.json must be a JSON object.");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Unknown / removed-in-v5 root keys (release-please rejects unknown keys).
  for (const key of Object.keys(config)) {
    if (!KNOWN_ROOT_KEYS.has(key)) {
      errors.push(`Unknown release-please config key at root: "${toSingleLineDisplay(key)}".`);
    }
  }

  // A root-level release-type is inherited by packages as the default; validate
  // it when present.
  const rootReleaseType = config["release-type"];
  if (rootReleaseType !== undefined && !KNOWN_RELEASE_TYPES.has(rootReleaseType)) {
    errors.push(`Invalid root release-type: "${toSingleLineDisplay(rootReleaseType)}".`);
  }

  // `packages` is the sole required key; it must be a non-empty object.
  const packages = config.packages;
  if (!isPlainObject(packages)) {
    errors.push(
      'release-please-config.json is missing a "packages" object (required by release-please v5).',
    );
    return { ok: false, errors };
  }
  const configPaths = Object.keys(packages);
  if (configPaths.length === 0) {
    errors.push('release-please-config.json "packages" must contain at least one package.');
  }

  // Per-package validation: known keys + valid release-type.
  for (const path of configPaths) {
    const pkg = packages[path];
    if (!isPlainObject(pkg)) {
      errors.push(`Package "${toSingleLineDisplay(path)}" must map to a config object.`);
      continue;
    }
    for (const key of Object.keys(pkg)) {
      if (!KNOWN_PACKAGE_KEYS.has(key)) {
        errors.push(
          `Unknown release-please config key for package "${toSingleLineDisplay(path)}": "${toSingleLineDisplay(key)}".`,
        );
      }
    }
    const releaseType = pkg["release-type"];
    if (releaseType !== undefined && !KNOWN_RELEASE_TYPES.has(releaseType)) {
      errors.push(
        `Invalid release-type for package "${toSingleLineDisplay(path)}": "${toSingleLineDisplay(releaseType)}".`,
      );
    }
  }

  // Manifest paths (a `$schema` pointer, if present, is not a package path).
  const manifestPaths = Object.keys(manifest).filter((key) => key !== "$schema");

  // Every manifest version must be valid semver.
  for (const path of manifestPaths) {
    if (!isValidSemver(manifest[path])) {
      errors.push(
        `Manifest version for "${toSingleLineDisplay(path)}" is not valid semver: ${toSingleLineDisplay(JSON.stringify(manifest[path]))}.`,
      );
    }
  }

  // Bijection: config.packages <-> manifest paths. Drift here is the classic
  // manifest-mode failure — release-please cannot find a version for a package
  // (or releases a package that no longer exists) post-merge.
  const manifestSet = new Set(manifestPaths);
  for (const path of configPaths) {
    if (!manifestSet.has(path)) {
      errors.push(
        `Package "${toSingleLineDisplay(path)}" is declared in release-please-config.json but has no entry in .release-please-manifest.json.`,
      );
    }
  }
  const configSet = new Set(configPaths);
  for (const path of manifestPaths) {
    if (!configSet.has(path)) {
      errors.push(
        `Manifest entry "${toSingleLineDisplay(path)}" has no matching package in release-please-config.json.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {string} filePath
 * @returns {unknown} Parsed JSON.
 * @throws {Error} when the file cannot be read or is not valid JSON.
 */
function loadJson(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @param {string[]} argv Positional args: [configPath?, manifestPath?].
 * @returns {number} Process exit code (0 = valid, 1 = invalid/unreadable).
 */
function main(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = argv[0] ? resolve(argv[0]) : resolve(repoRoot, "release-please-config.json");
  const manifestPath = argv[1]
    ? resolve(argv[1])
    : resolve(repoRoot, ".release-please-manifest.json");

  // Confine both paths to the repo root before reading anything. The shipped
  // workflow passes no positional args (defaults resolve under repoRoot), but a
  // supplied path must never escape via `..`, an absolute path, or a sibling-
  // prefix look-alike (defense-in-depth, issue #2181 item 7).
  for (const candidate of [configPath, manifestPath]) {
    if (!isPathWithinRoot(candidate, repoRoot)) {
      console.error(
        `\u2716 Refusing to read a path outside the repository root: ${toSingleLineDisplay(candidate)}`,
      );
      return 1;
    }
  }

  let config;
  let manifest;
  try {
    config = loadJson(configPath);
    manifest = loadJson(manifestPath);
  } catch (err) {
    // The path and the JSON parser's message can both echo attacker-controlled
    // bytes (a malicious file's contents surface in JSON.parse errors), so the
    // whole displayed message is sanitized (issue #2181 item 6).
    console.error(`\u2716 ${toSingleLineDisplay(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }

  const { ok, errors } = validateReleasePleaseConfig(config, manifest);
  if (ok) {
    console.log("\u2714 release-please v5 config and manifest are valid.");
    return 0;
  }

  console.error("\u2716 release-please v5 config/manifest validation failed:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  console.error(
    "\nThese would break release-please-action v5 (release-please core v17) post-merge on main. " +
      "Fix release-please-config.json / .release-please-manifest.json before merging.",
  );
  return 1;
}

// Run only when executed directly (e.g. `node scripts/...`), never when this
// module is imported by the unit test.
const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}

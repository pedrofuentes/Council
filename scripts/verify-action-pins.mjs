#!/usr/bin/env node
// @ts-check
/**
 * Supply-chain provenance gate for pinned GitHub Actions.
 *
 * The repo standard is to pin every `uses:` to a 40-hex commit SHA with a
 * trailing `# vX.Y.Z` comment naming the release the SHA came from, e.g.:
 *
 *     uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
 *
 * A stale or forged comment defeats the point of SHA pinning: a reviewer
 * trusts the human-readable tag while the SHA silently points elsewhere. This
 * script proves the two agree — for every pin it resolves the commented tag to
 * a commit via the GitHub API and asserts that commit equals the pinned SHA.
 *
 * Two layers:
 *   1. `parseActionPins(yamlText, filename)` / `normalizeTag(comment)` — PURE.
 *      String-in, structured-out. No filesystem or network access. These are
 *      the unit-tested core (see packages/cli/tests/unit/ci/).
 *   2. `main()` — runnable entrypoint. Reads .github/workflows/<*>.yml, parses
 *      the pins, resolves each tag -> commit via `gh api` (auth from
 *      GH_TOKEN / GITHUB_TOKEN), dereferencing annotated tag objects, and
 *      reports every mismatch. Network; integration-only, not unit-tested.
 *
 * Exit code: 0 when every pin's SHA matches its tag and there are no
 * unverifiable external references; non-zero otherwise.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A 40-character lowercase-hex git commit SHA. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A pinned action reference that carries a verifiable version comment.
 * @typedef {object} ActionPin
 * @property {string} file  - workflow filename the pin was found in
 * @property {number} line  - 1-based line number of the `uses:` line
 * @property {string} owner - repository owner (first path segment)
 * @property {string} repo  - repository name (second path segment)
 * @property {string} sha   - 40-hex commit SHA the action is pinned to
 * @property {string} tag   - normalized release tag from the comment (e.g. "v6.0.9")
 * @property {string} ref   - full reference as written (owner/repo[/subpath])
 */

/**
 * An external `uses:` that cannot be provenance-checked: SHA-pinned but with
 * no version comment, or referencing a mutable tag/branch instead of a SHA.
 * @typedef {object} UnverifiablePin
 * @property {string} file
 * @property {number} line
 * @property {string} uses   - the raw reference after `uses:`
 * @property {string} reason - why it cannot be verified
 */

/**
 * @typedef {object} ParseResult
 * @property {ActionPin[]} pins
 * @property {UnverifiablePin[]} unverifiable
 */

/**
 * Normalize a trailing `uses:` comment into a bare release tag.
 *
 * Handles the repo's conventional `# vX.Y.Z` form plus lenient variants such
 * as `pin v6.0.9`, a major-only `v1`, or `tag: v2.1.0`. Returns `null` when the
 * comment contains no recognizable `vN[.N[.N]]` token.
 *
 * @param {string} comment
 * @returns {string | null}
 */
export function normalizeTag(comment) {
  if (!comment) return null;
  const match = /\bv\d+(?:\.\d+){0,2}\b/.exec(comment);
  return match ? match[0] : null;
}

/**
 * Extract and classify every `uses:` reference in a workflow YAML document.
 *
 * PURE: no filesystem or network access. Recognizes:
 *   uses: <owner>/<repo>[/<subpath...>]@<40-hex-sha> # <tag>
 * and returns those in `pins`. Local composite actions (`uses: ./…` or
 * `uses: ../…`) are ignored — there is no external release to verify. External
 * references that are SHA-pinned without a version comment, that pin a mutable
 * tag/branch instead of a SHA, or that are `docker://` images are returned in
 * `unverifiable` so the caller can surface the provenance gap.
 *
 * @param {string} yamlText
 * @param {string} filename
 * @returns {ParseResult}
 */
export function parseActionPins(yamlText, filename) {
  /** @type {ActionPin[]} */
  const pins = [];
  /** @type {UnverifiablePin[]} */
  const unverifiable = [];

  const lines = yamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = i + 1;
    // A `uses:` key, either as a list item (`- uses:`) or a mapping value
    // (`uses:`), capturing everything after the colon.
    const keyMatch = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/.exec(lines[i]);
    if (!keyMatch) continue;

    let value = keyMatch[1].trim();

    // Split off an inline `# comment`. A reference token never contains a
    // space, so the first `#` begins the comment.
    let comment = "";
    const hashIdx = value.indexOf("#");
    if (hashIdx !== -1) {
      comment = value.slice(hashIdx + 1).trim();
      value = value.slice(0, hashIdx).trim();
    }

    // Drop wrapping quotes: uses: "actions/checkout@<sha>".
    value = value.replace(/^["']|["']$/g, "").trim();
    if (value === "") continue;

    // Local composite action — nothing external to verify.
    if (value.startsWith("./") || value.startsWith("../")) continue;

    if (value.startsWith("docker://")) {
      unverifiable.push({ file: filename, line, uses: value, reason: "docker:// image reference" });
      continue;
    }

    const atIdx = value.lastIndexOf("@");
    if (atIdx === -1) {
      unverifiable.push({ file: filename, line, uses: value, reason: "no @ref (unpinned)" });
      continue;
    }

    const ref = value.slice(0, atIdx); // owner/repo[/subpath]
    const gitRef = value.slice(atIdx + 1); // sha, tag, or branch
    const segments = ref.split("/");
    const owner = segments[0] ?? "";
    const repo = segments[1] ?? "";

    if (!SHA_RE.test(gitRef)) {
      unverifiable.push({
        file: filename,
        line,
        uses: value,
        reason: `not pinned to a 40-hex commit SHA (ref: ${gitRef})`,
      });
      continue;
    }

    const tag = normalizeTag(comment);
    if (tag === null) {
      unverifiable.push({
        file: filename,
        line,
        uses: value,
        reason: "SHA-pinned but missing a `# <tag>` version comment",
      });
      continue;
    }

    pins.push({ file: filename, line, owner, repo, sha: gitRef.toLowerCase(), tag, ref });
  }

  return { pins, unverifiable };
}

// --- Runnable entrypoint (network; integration-only, not unit-tested) --------

/**
 * Invoke `gh api <path>` and parse the JSON response.
 * @param {string} apiPath
 * @returns {Promise<any>}
 */
async function ghApiJson(apiPath) {
  const { stdout } = await execFileAsync("gh", ["api", apiPath], {
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/**
 * Resolve a release tag to the commit SHA it ultimately points at, following
 * annotated tag objects to their underlying commit.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag
 * @returns {Promise<string>} the 40-hex commit SHA (lowercase)
 */
async function resolveTagToCommit(owner, repo, tag) {
  // Exact-match "get a reference": returns a single ref, 404s when absent.
  const reference = await ghApiJson(`repos/${owner}/${repo}/git/ref/tags/${tag}`);
  let object = reference.object;

  // Lightweight tags point straight at a commit; annotated tags point at a tag
  // object that must be dereferenced. Loop defensively in case of tag-of-tag.
  let guard = 0;
  while (object && object.type === "tag" && guard < 5) {
    const annotated = await ghApiJson(`repos/${owner}/${repo}/git/tags/${object.sha}`);
    object = annotated.object;
    guard += 1;
  }

  if (!object || object.type !== "commit" || typeof object.sha !== "string") {
    throw new Error(`tag ${tag} did not resolve to a commit (got ${object?.type ?? "nothing"})`);
  }
  return object.sha.toLowerCase();
}

/**
 * List workflow YAML filenames in a directory, sorted for stable output.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectWorkflowFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Verify every pinned action SHA against its commented release tag.
 * @returns {Promise<number>} process exit code
 */
async function main() {
  const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));

  const files = await collectWorkflowFiles(workflowsDir);
  if (files.length === 0) {
    console.error(`verify-action-pins: no workflow files found in ${workflowsDir}`);
    return 1;
  }

  /** @type {ActionPin[]} */
  const pins = [];
  /** @type {UnverifiablePin[]} */
  const unverifiable = [];
  for (const file of files) {
    const text = await readFile(join(workflowsDir, file), "utf8");
    const parsed = parseActionPins(text, file);
    pins.push(...parsed.pins);
    unverifiable.push(...parsed.unverifiable);
  }

  console.log(
    `Verifying ${pins.length} pinned action(s) across ${files.length} workflow file(s)...`,
  );

  /** @type {Map<string, string>} */
  const cache = new Map();
  const mismatches = [];
  const errors = [];
  let okCount = 0;

  for (const pin of pins) {
    const key = `${pin.owner}/${pin.repo}@${pin.tag}`;
    try {
      let commit = cache.get(key);
      if (commit === undefined) {
        commit = await resolveTagToCommit(pin.owner, pin.repo, pin.tag);
        cache.set(key, commit);
      }
      if (commit === pin.sha) {
        okCount += 1;
        console.log(`  ok        ${pin.file}:${pin.line}  ${pin.ref}  ${pin.tag} == ${pin.sha}`);
      } else {
        mismatches.push({ pin, commit });
        console.log(
          `  MISMATCH  ${pin.file}:${pin.line}  ${pin.ref}  ${pin.tag} -> ${commit}, but pinned to ${pin.sha}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ pin, message });
      console.log(`  ERROR     ${pin.file}:${pin.line}  ${pin.ref}  ${pin.tag}: ${message}`);
    }
  }

  if (unverifiable.length > 0) {
    console.log("\nUnverifiable external action reference(s):");
    for (const entry of unverifiable) {
      console.log(`  - ${entry.file}:${entry.line}  ${entry.uses}  (${entry.reason})`);
    }
  }

  const failures = mismatches.length + errors.length + unverifiable.length;
  console.log("");
  if (failures === 0) {
    console.log(`All ${okCount} pinned action SHA(s) match their commented release tags.`);
    return 0;
  }

  console.error(
    `FAILED: ${mismatches.length} tag/SHA mismatch(es), ${errors.length} resolution error(s), ` +
      `${unverifiable.length} unverifiable reference(s). See report above.`,
  );
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`verify-action-pins: fatal: ${message}`);
      process.exit(1);
    });
}

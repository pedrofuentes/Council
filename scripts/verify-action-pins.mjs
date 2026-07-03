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
 *      reports every mismatch. The `gh api` calls are wrapped with a per-call
 *      timeout and transient-only backoff/jitter retry whose classifier and
 *      retry helpers (`isTransientGhError`, `withRetry`, `computeBackoffDelay`)
 *      are pure + injectable and unit-tested; only the default `gh` executor
 *      touches the network and stays integration-only.
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

// --- Terminal-safe display sanitizer -----------------------------------------
//
// This script parses attacker-controllable `.github/workflows/*.yml` content (a
// `pull_request` can edit a `uses:` line) and echoes derived fields to CI logs.
// Untrusted control/escape bytes in those fields would let a malicious PR spoof
// log lines or manipulate the terminal (OSC title/clipboard/cursor) when raw
// logs are viewed. Every DISPLAYED string is therefore sanitized; comparison
// and tag resolution keep using the RAW values.
//
// Self-contained mirror of the repo's canonical `toSingleLineDisplay` in
// packages/cli/src/cli/strip-control-chars.ts — this standalone Node ESM script
// cannot import from packages/cli. Keep the two in sync.

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
 * Sanitize untrusted text for single-line display in CI logs.
 *
 * Strips ANSI CSI/OSC/DCS/SOS/PM/APC escape sequences, C0 (except TAB/LF/CR),
 * DEL and C1 controls, strong bidi controls, and zero-width/hidden format
 * characters, then folds any surviving CR/LF/TAB/U+2028/U+2029 run to a single
 * space so the result always renders on one line. Display-only: callers must
 * keep comparing and resolving the RAW value.
 *
 * @param {string} text
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
 * Format a fatal (top-level, outside the per-pin loop) error into a single safe
 * CI-log line. A caught error's `stack`/`message` can transitively include
 * attacker-editable workflow text — e.g. a control-char-laden `uses:` filename
 * surfaced through a `readFile`/parse failure — so it is routed through
 * {@link toSingleLineDisplay} (stripping escape/control bytes and folding to one
 * line), exactly like the per-pin error output in `main()`. The raw error is
 * never compared or resolved against; this is display-only (issue #2181).
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatFatalError(error) {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return toSingleLineDisplay(raw);
}

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

// --- gh api resilience: per-call timeout + bounded backoff/jitter retry ------
//
// The tag -> commit resolution below shells out to `gh api`. A transient
// GitHub API fault (HTTP 429, 5xx, or a network/timeout blip) during that call
// used to be caught per-pin and counted as a hard failure, turning an
// otherwise-valid PR check spuriously red (issue #2182). We therefore:
//   1. bound every `gh api` call with an explicit timeout (no hung CI), and
//   2. retry ONLY transient faults with exponential backoff + full jitter.
// A genuine 404 "tag not found" (or any other 4xx) is a real provenance
// problem and MUST fail fast — retrying it would mask a tag/SHA mismatch.
//
// The classifier and retry helpers are pure and injectable (executor, sleep,
// and jitter source), so they are unit-tested with no network and no real
// waits (see packages/cli/tests/unit/ci/verify-action-pins.test.ts). Only the
// default `gh` executor touches the network and stays integration-only.

/** Hard per-call timeout for a single `gh api` invocation (ms). */
const GH_API_TIMEOUT_MS = 20_000;
/** Total bounded attempts (1 initial + up to 3 retries) per `gh api` call. */
const GH_API_RETRY_ATTEMPTS = 4;
/** Base delay for the first backoff window (ms). */
const GH_API_RETRY_BASE_MS = 500;
/** Ceiling for any single backoff window before jitter (ms). */
const GH_API_RETRY_MAX_MS = 8_000;

/**
 * Promise-based sleep. Default injectable delay used by {@link withRetry}.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flatten a `gh api` failure into a single text blob for transient/terminal
 * classification. Node's execFile timeout kill carries no HTTP status or useful
 * message, so a synthetic "timed out" marker is added when the process was
 * killed; `stderr` (where `gh` prints `... (HTTP <status>)`), `stdout`, and any
 * string syscall `code` (e.g. ETIMEDOUT) are included so {@link
 * isTransientGhError} can read them.
 *
 * The echoed command line — Node's execFile `err.message`, i.e. `"Command
 * failed: gh api repos/<owner>/<repo>/..."` — is DELIBERATELY EXCLUDED. That
 * `owner/repo/tag` is attacker-editable via a workflow `uses:` line (a
 * `pull_request` can change it), so letting it reach the classifier would let a
 * name like `evil-timeout/foo` or a `503-…` tag masquerade as a transient
 * fault and steer the retry gate (issue #2184). Only `gh`/OS-generated fields
 * (stderr/stdout/code + the synthetic timeout marker) inform classification;
 * the raw `err.message` is still surfaced verbatim to humans by `main()`.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function ghErrorText(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const err = /** @type {Record<string, unknown>} */ (error);
  const parts = [];
  if (err.killed === true) parts.push("gh api call timed out (process killed by client timeout)");
  if (typeof err.stderr === "string" && err.stderr.length > 0) parts.push(err.stderr);
  if (typeof err.stdout === "string" && err.stdout.length > 0) parts.push(err.stdout);
  if (typeof err.code === "string" && err.code.length > 0) parts.push(err.code);
  // NOTE: err.message is intentionally omitted — see the doc comment above.
  if (parts.length > 0) return parts.join("\n");
  // No gh/OS-generated field was captured. `String(error)` would re-admit Node's
  // echoed "Command failed: gh api repos/<owner>/<repo>/..." line, smuggling the
  // attacker-editable owner/repo/tag back into the classifier and letting a
  // transient-sounding name steer the retry gate (issues #2184, #2187). Strip
  // that echoed command line; any genuinely gh/OS-generated remainder is kept,
  // and an empty result classifies TERMINAL — fail-closed, never a false retry.
  return String(error)
    .replace(/^(?:[\w$.]*Error:\s*)?Command failed:.*$/gm, "")
    .trim();
}

/** Node/libc socket + DNS + connection syscall codes that are always retryable. */
const TRANSIENT_SYSCALL_RE =
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/;

/** Human-readable network/timeout phrases `gh`/git/net stacks emit. */
const TRANSIENT_PHRASE_RE =
  /timed out|timeout|socket hang up|connection reset|connection refused|network is unreachable|temporary failure in name resolution|tls handshake|i\/o timeout|unexpected eof/i;

/**
 * Decide whether a `gh api` failure (as flattened text) is a TRANSIENT fault
 * worth retrying, versus a TERMINAL fault that must fail fast.
 *
 * The HTTP status is the authoritative, non-forgeable signal and is parsed
 * FIRST: `gh` prints `... (HTTP <status>)` to stderr, and when a status is
 * present it ALONE decides terminality. This is a security property, not just
 * ordering — the flattened text may include attacker-influenced fragments, so
 * a real terminal 4xx (esp. a 404 "tag not found") must never be reclassified
 * as transient by a name/phrase elsewhere in the blob (issue #2184).
 *
 *   - HTTP 429 or any 5xx        -> transient (retry)
 *   - HTTP 403 WITH rate-limit    -> transient (GitHub reports rate limits as 403)
 *   - any other 4xx (401/404/422) -> terminal (fail fast; do not mask a real
 *                                    provenance mismatch)
 *
 * Only when NO HTTP status is determinable — a pure network/DNS/timeout failure
 * with no HTTP response — do we fall back to matching network/connection/
 * timeout phrases and syscall codes. `ghErrorText` keeps the attacker-editable
 * echoed command line out of that text, so the fallback sees only `gh`/OS-
 * generated fields (stderr/`code`/synthetic timeout marker).
 *
 * @param {string} errText
 * @returns {boolean} true when the fault is transient (safe to retry)
 */
export function isTransientGhError(errText) {
  const text = String(errText);

  // 1. HTTP status decides terminality on its own — parse it FIRST so no
  //    attacker-influenced name/phrase in `text` can flip the verdict.
  const httpMatch = /\bHTTP (\d{3})\b/.exec(text);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    // GitHub may answer 403 for (secondary) rate limits — those are transient.
    if (status === 403 && /rate limit/i.test(text)) return true;
    // Every other 4xx (esp. 404 tag-not-found) is a real, terminal problem.
    return false;
  }

  // 2. No HTTP status: a pure network/DNS/timeout failure. Only here may we
  //    fall back to phrase/syscall matching — against gh/OS-generated text.
  if (TRANSIENT_SYSCALL_RE.test(text)) return true;
  if (TRANSIENT_PHRASE_RE.test(text)) return true;
  // Rate-limit messaging with no parenthetical status is still transient.
  if (/rate limit/i.test(text)) return true;
  return false;
}

/**
 * Full-jitter exponential backoff delay for a given 1-based attempt. The
 * un-jittered window doubles each attempt (base, 2·base, 4·base, …) capped at
 * `maxDelayMs`; the returned delay is a uniform random point in `[0, window)`
 * so concurrent CI jobs don't retry in lockstep (thundering herd).
 *
 * @param {number} attempt  1-based attempt number
 * @param {{ baseDelayMs?: number, maxDelayMs?: number, random?: () => number }} [options]
 * @returns {number} delay in whole milliseconds
 */
export function computeBackoffDelay(attempt, options = {}) {
  const {
    baseDelayMs = GH_API_RETRY_BASE_MS,
    maxDelayMs = GH_API_RETRY_MAX_MS,
    random = Math.random,
  } = options;
  const exponent = Math.max(0, attempt - 1);
  const windowMs = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  return Math.floor(random() * windowMs);
}

/**
 * @typedef {object} RetryOptions
 * @property {number} [attempts]     total bounded attempts (>= 1)
 * @property {number} [baseDelayMs]
 * @property {number} [maxDelayMs]
 * @property {(error: unknown) => boolean} [isRetryable]  retry predicate
 * @property {(ms: number) => Promise<void>} [sleep]      injectable delay
 * @property {() => number} [random]                      injectable jitter source
 */

/**
 * Run `fn` with bounded retries. Retries only when `isRetryable(error)` is true,
 * sleeping a {@link computeBackoffDelay} interval between attempts, and rethrows
 * the last error once attempts are exhausted or the error is non-retryable.
 * Pure/injectable so tests supply a fake `sleep`/`random` and never really wait.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    attempts = GH_API_RETRY_ATTEMPTS,
    baseDelayMs = GH_API_RETRY_BASE_MS,
    maxDelayMs = GH_API_RETRY_MAX_MS,
    isRetryable = () => false,
    sleep = defaultSleep,
    random = Math.random,
  } = options;
  const maxAttempts = Math.max(1, Math.floor(attempts));

  /** @type {unknown} */
  let lastError = new Error("withRetry: no attempts were made");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) break;
      await sleep(computeBackoffDelay(attempt, { baseDelayMs, maxDelayMs, random }));
    }
  }
  throw lastError;
}

// --- Runnable entrypoint (default executor is network; integration-only) -----

/**
 * @typedef {object} GhExecResult
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * Default `gh api` executor: runs `gh api <path>` with a hard timeout. Rejects
 * (per Node's execFile) on non-zero exit or when the timeout kills the child.
 *
 * @param {string} apiPath
 * @param {number} timeoutMs
 * @returns {Promise<GhExecResult>}
 */
function defaultGhExec(apiPath, timeoutMs) {
  return execFileAsync("gh", ["api", apiPath], {
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

/**
 * @typedef {object} GhApiOptions
 * @property {(apiPath: string, timeoutMs: number) => Promise<GhExecResult>} [exec] injectable executor
 * @property {number} [timeoutMs]    per-call timeout override
 * @property {number} [attempts]     bounded retry attempts override
 * @property {number} [baseDelayMs]
 * @property {number} [maxDelayMs]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 */

/**
 * Invoke `gh api <path>` (with per-call timeout + transient-only retry) and
 * parse the JSON response.
 *
 * @param {string} apiPath
 * @param {GhApiOptions} [options]
 * @returns {Promise<any>}
 */
export async function ghApiJson(apiPath, options = {}) {
  const {
    exec = defaultGhExec,
    timeoutMs = GH_API_TIMEOUT_MS,
    attempts = GH_API_RETRY_ATTEMPTS,
    baseDelayMs = GH_API_RETRY_BASE_MS,
    maxDelayMs = GH_API_RETRY_MAX_MS,
    sleep,
    random,
  } = options;

  const { stdout } = await withRetry(() => exec(apiPath, timeoutMs), {
    attempts,
    baseDelayMs,
    maxDelayMs,
    isRetryable: (error) => isTransientGhError(ghErrorText(error)),
    sleep,
    random,
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
 * @param {GhApiOptions} [options]  forwarded to each {@link ghApiJson} call
 * @returns {Promise<string>} the 40-hex commit SHA (lowercase)
 */
export async function resolveTagToCommit(owner, repo, tag, options = {}) {
  // Exact-match "get a reference": returns a single ref, 404s when absent.
  const reference = await ghApiJson(`repos/${owner}/${repo}/git/ref/tags/${tag}`, options);
  let object = reference.object;

  // Lightweight tags point straight at a commit; annotated tags point at a tag
  // object that must be dereferenced. Loop defensively in case of tag-of-tag.
  let guard = 0;
  while (object && object.type === "tag" && guard < 5) {
    const annotated = await ghApiJson(`repos/${owner}/${repo}/git/tags/${object.sha}`, options);
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
        console.log(
          `  ok        ${toSingleLineDisplay(pin.file)}:${pin.line}  ${toSingleLineDisplay(pin.ref)}  ${toSingleLineDisplay(pin.tag)} == ${toSingleLineDisplay(pin.sha)}`,
        );
      } else {
        mismatches.push({ pin, commit });
        console.log(
          `  MISMATCH  ${toSingleLineDisplay(pin.file)}:${pin.line}  ${toSingleLineDisplay(pin.ref)}  ${toSingleLineDisplay(pin.tag)} -> ${toSingleLineDisplay(commit)}, but pinned to ${toSingleLineDisplay(pin.sha)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ pin, message });
      console.log(
        `  ERROR     ${toSingleLineDisplay(pin.file)}:${pin.line}  ${toSingleLineDisplay(pin.ref)}  ${toSingleLineDisplay(pin.tag)}: ${toSingleLineDisplay(message)}`,
      );
    }
  }

  if (unverifiable.length > 0) {
    console.log("\nUnverifiable external action reference(s):");
    for (const entry of unverifiable) {
      console.log(
        `  - ${toSingleLineDisplay(entry.file)}:${entry.line}  ${toSingleLineDisplay(entry.uses)}  (${toSingleLineDisplay(entry.reason)})`,
      );
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
      console.error(`verify-action-pins: fatal: ${formatFatalError(error)}`);
      process.exit(1);
    });
}

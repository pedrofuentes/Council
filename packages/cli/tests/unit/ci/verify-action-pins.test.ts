/**
 * Unit tests for the pure parsing layer of the action-pin provenance gate.
 *
 * `parseActionPins()` is the string-in/structured-out core of
 * `scripts/verify-action-pins.mjs`. It scans a workflow YAML document and
 * classifies every `uses:` reference into:
 *   - `pins`         — external actions pinned to a 40-hex commit SHA AND
 *                      carrying a `# <tag>` version comment (verifiable).
 *   - `unverifiable` — external actions that are SHA-pinned but lack a version
 *                      comment, or that reference a mutable tag/branch instead
 *                      of a SHA. Local `uses: ./…` composite actions are
 *                      ignored entirely (there is nothing external to verify).
 *
 * These tests are hermetic — no filesystem or network access. The live
 * tag → commit resolution in the script's entrypoint is integration-only and
 * is intentionally NOT exercised here.
 *
 * RED at this commit: `scripts/verify-action-pins.mjs` does not exist yet.
 */
import { describe, expect, it } from "vitest";

// The verifier is a repo-root ESM script (node: builtins only), imported here
// purely for its pure parsing/sanitizing exports.
import {
  computeBackoffDelay,
  formatFatalError,
  ghApiJson,
  ghErrorText,
  isTransientGhError,
  normalizeTag,
  parseActionPins,
  resolveTagToCommit,
  toSingleLineDisplay,
  withRetry,
} from "../../../../../scripts/verify-action-pins.mjs";

const CHECKOUT_SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const PNPM_SHA = "0ebf47130e4866e96fce0953f49152a61190b271";
const SETUP_NODE_SHA = "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const CODEQL_SHA = "51f77329afa6477de8c49fc9c7046c15b9a4e79d";
const CFLITE_SHA = "884713a6c30a92e5e8544c39945cd7cb630abcd1";
const WITHPIN_SHA = "1111111111111111111111111111111111111111";
const ZERO_SHA = "0000000000000000000000000000000000000000";

// A representative workflow that mirrors the repo's real pin format plus the
// edge cases the gate must classify: a subpath action, an annotated-tag major
// (`# v1`), a `# pin vX.Y.Z` comment, a local composite action, a SHA pin with
// no comment, and a mutable `@v4` tag reference.
const FIXTURE = `name: Example
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.0
      - uses: pnpm/action-setup@${PNPM_SHA} # v6.0.9
      - uses: actions/setup-node@${SETUP_NODE_SHA} # v6.4.0
        with:
          node-version: "24"
      - uses: github/codeql-action/upload-sarif@${CODEQL_SHA} # v3.29.5
      - uses: google/clusterfuzzlite/actions/build_fuzzers@${CFLITE_SHA} # v1
      - name: Local composite action
        uses: ./.github/actions/setup
      - uses: some/action@${ZERO_SHA}
      - uses: another/action@v4
      - uses: pinned/withpin@${WITHPIN_SHA} # pin v2.3.4
`;

const findPin = (pins, repo) => pins.find((p) => p.repo === repo);
const lineOf = (needle) => FIXTURE.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("parseActionPins", () => {
  it("extracts every SHA-pinned action that carries a version comment", () => {
    const { pins } = parseActionPins(FIXTURE, "ci.yml");
    // checkout, pnpm, setup-node, codeql, clusterfuzzlite, withpin — 6 total.
    expect(pins).toHaveLength(6);
  });

  it("captures owner, repo, sha and normalized tag for a standard pin", () => {
    const { pins } = parseActionPins(FIXTURE, "ci.yml");
    const pin = findPin(pins, "checkout");
    expect(pin).toBeDefined();
    expect(pin?.owner).toBe("actions");
    expect(pin?.repo).toBe("checkout");
    expect(pin?.sha).toBe(CHECKOUT_SHA);
    expect(pin?.tag).toBe("v7.0.0");
  });

  it("records the source filename and 1-based line number of each pin", () => {
    const { pins } = parseActionPins(FIXTURE, "ci.yml");
    const pin = findPin(pins, "action-setup");
    expect(pin).toBeDefined();
    expect(pin?.file).toBe("ci.yml");
    expect(pin?.line).toBe(lineOf(PNPM_SHA));
  });

  it("takes owner/repo from the first two path segments of a subpath action", () => {
    const { pins } = parseActionPins(FIXTURE, "ci.yml");
    const pin = findPin(pins, "codeql-action");
    expect(pin).toBeDefined();
    expect(pin?.owner).toBe("github");
    expect(pin?.repo).toBe("codeql-action");
    expect(pin?.sha).toBe(CODEQL_SHA);
    expect(pin?.tag).toBe("v3.29.5");
  });

  it("parses a major-only annotated tag comment (# v1)", () => {
    const { pins } = parseActionPins(FIXTURE, "ci.yml");
    const pin = findPin(pins, "clusterfuzzlite");
    expect(pin).toBeDefined();
    expect(pin?.owner).toBe("google");
    expect(pin?.tag).toBe("v1");
  });

  it("normalizes a `# pin vX.Y.Z` comment down to the bare tag", () => {
    const { pins } = parseActionPins(FIXTURE, "ci.yml");
    const pin = findPin(pins, "withpin");
    expect(pin).toBeDefined();
    expect(pin?.tag).toBe("v2.3.4");
  });

  it("ignores local composite `uses: ./…` references entirely", () => {
    const { pins, unverifiable } = parseActionPins(FIXTURE, "ci.yml");
    expect(pins.some((p) => p.ref.startsWith("."))).toBe(false);
    expect(unverifiable.some((u) => u.uses.startsWith("."))).toBe(false);
  });

  it("reports SHA pins with no version comment as unverifiable", () => {
    const { unverifiable } = parseActionPins(FIXTURE, "ci.yml");
    const entry = unverifiable.find((u) => u.uses.includes("some/action"));
    expect(entry).toBeDefined();
    expect(entry?.line).toBe(lineOf(ZERO_SHA));
    expect(entry?.reason).toMatch(/comment/i);
  });

  it("reports mutable tag/branch references (not a 40-hex SHA) as unverifiable", () => {
    const { unverifiable } = parseActionPins(FIXTURE, "ci.yml");
    const entry = unverifiable.find((u) => u.uses.includes("another/action"));
    expect(entry).toBeDefined();
    expect(entry?.reason).toMatch(/sha/i);
  });

  it("returns exactly the two unverifiable entries in the fixture", () => {
    const { unverifiable } = parseActionPins(FIXTURE, "ci.yml");
    expect(unverifiable).toHaveLength(2);
  });

  it("returns empty lists for a document with no uses: lines", () => {
    const { pins, unverifiable } = parseActionPins("name: empty\non: [push]\n", "empty.yml");
    expect(pins).toEqual([]);
    expect(unverifiable).toEqual([]);
  });
});

describe("normalizeTag", () => {
  it("passes through a plain semver tag", () => {
    expect(normalizeTag("v7.0.0")).toBe("v7.0.0");
  });

  it("strips a leading `pin` keyword", () => {
    expect(normalizeTag("pin v6.0.9")).toBe("v6.0.9");
  });

  it("accepts a major-only tag", () => {
    expect(normalizeTag("v1")).toBe("v1");
  });

  it("returns null when there is no recognizable version tag", () => {
    expect(normalizeTag("renovate: automerge")).toBeNull();
    expect(normalizeTag("")).toBeNull();
  });
});

describe("toSingleLineDisplay", () => {
  // The verifier echoes workflow-file/API-derived fields (pin.file, pin.ref,
  // pin.tag, pin.sha, entry.uses, entry.reason, the resolved commit, and error
  // messages) to CI logs. A malicious PR can edit a `uses:` line to smuggle
  // ANSI/OSC/C0/C1 escape bytes into those fields, so every DISPLAYED string
  // must be sanitized. This mirrors the canonical
  // packages/cli/src/cli/strip-control-chars.ts `toSingleLineDisplay`.

  it("preserves a plain owner/repo reference unchanged", () => {
    expect(toSingleLineDisplay("actions/checkout")).toBe("actions/checkout");
    expect(toSingleLineDisplay("github/codeql-action/upload-sarif")).toBe(
      "github/codeql-action/upload-sarif",
    );
  });

  it("preserves a semver release tag and a bare 40-hex commit SHA unchanged", () => {
    expect(toSingleLineDisplay("v7.0.0")).toBe("v7.0.0");
    expect(toSingleLineDisplay(CHECKOUT_SHA)).toBe(CHECKOUT_SHA);
  });

  it("strips ANSI CSI color sequences without leaving the `[31m` suffix", () => {
    expect(toSingleLineDisplay("\x1B[31mevil/checkout\x1B[0m")).toBe("evil/checkout");
  });

  it("strips OSC sequences terminated by BEL (e.g. set terminal title)", () => {
    expect(toSingleLineDisplay("foo/bar@\x1B]0;PWNED\x07mutabletag")).toBe("foo/bar@mutabletag");
  });

  it("strips OSC 8 hyperlink sequences terminated by ST (ESC backslash)", () => {
    expect(toSingleLineDisplay("a\x1B]8;;https://evil.example/\x1B\\b")).toBe("ab");
  });

  it("strips DCS/APC sequences (ESC P … ST and ESC _ … ST)", () => {
    expect(toSingleLineDisplay("a\x1BPq;1|payload\x1B\\b\x1B_apc-smuggle\x1B\\c")).toBe("abc");
  });

  it("strips PM/SOS sequences (ESC ^ … ST and ESC X … ST)", () => {
    expect(toSingleLineDisplay("x\x1B^pm\x1B\\y\x1BXsos\x1B\\z")).toBe("xyz");
  });

  it("strips C0 controls, DEL (0x7F), and C1 controls (U+0080–U+009F)", () => {
    expect(toSingleLineDisplay("a\x00b\x07c\x08d\x1Ee\x7Ff\x80g\x9Fh")).toBe("abcdefgh");
  });

  it("folds CR/LF/TAB and U+2028/U+2029 line separators to single spaces", () => {
    expect(toSingleLineDisplay("before\r\nafter\ttab\u2028sep\u2029end")).toBe(
      "before after tab sep end",
    );
  });

  it("strips zero-width and strong bidi-override characters", () => {
    expect(toSingleLineDisplay("na\u200Bme\u202Etext")).toBe("nametext");
  });

  it("neutralizes the reported pin.ref CSI-injection vector", () => {
    const dirty = "\u001B[31mevil/checkout";
    const clean = toSingleLineDisplay(dirty);
    expect(clean).toBe("evil/checkout");
    expect(clean).not.toContain("\u001B");
  });

  it("neutralizes the reported entry.uses OSC-injection vector", () => {
    const dirty = "foo/bar@\u001B]0;PWNED\u0007mutabletag";
    const clean = toSingleLineDisplay(dirty);
    expect(clean).toBe("foo/bar@mutabletag");
    expect(clean).not.toContain("\u001B");
    expect(clean).not.toContain("\u0007");
    expect(clean).not.toContain("PWNED");
  });

  it("sanitizes many unterminated DCS introducers in linear time (ReDoS guard)", () => {
    const dirty = "\x1BP".repeat(100000);
    const start = performance.now();
    const result = toSingleLineDisplay(dirty);
    const elapsed = performance.now() - start;
    expect(result).toBe("");
    expect(elapsed).toBeLessThan(1000);
  });
});

// --- Resilience layer: timeout + bounded backoff/jitter retry (issue #2182) ---
//
// The provenance gate resolves each pin's tag -> commit via `gh api`. A single
// transient GitHub API blip (rate-limit / 5xx / network / timeout) during that
// resolution was previously caught per-pin and counted as a hard failure,
// turning an otherwise-valid PR check spuriously red. The classifier +
// retry/backoff helpers below let the gate recover from TRANSIENT faults while
// still failing FAST on a genuine 404 (a real provenance mismatch must never be
// retry-masked). All helpers are injectable so these tests run with NO real
// network and NO real multi-second waits.

// A never-resolving/short-circuit sleep used to keep retry tests instant.
const noSleep = () => Promise.resolve();
// Deterministic jitter source: zero jitter keeps computed delays predictable.
const noJitter = () => 0;

describe("isTransientGhError", () => {
  it("classifies an HTTP 429 (rate-limited) response as transient", () => {
    expect(isTransientGhError("gh: API rate limit exceeded (HTTP 429)")).toBe(true);
  });

  it("classifies every HTTP 5xx response as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isTransientGhError(`gh: Server Error (HTTP ${status})`)).toBe(true);
    }
  });

  it("classifies network / connection-reset / socket / timeout errors as transient", () => {
    expect(isTransientGhError("request to https://api.github.com failed: ETIMEDOUT")).toBe(true);
    expect(isTransientGhError("connect ECONNRESET 140.82.113.5:443")).toBe(true);
    expect(isTransientGhError("dial tcp: lookup api.github.com: EAI_AGAIN")).toBe(true);
    expect(isTransientGhError('Post "https://api.github.com": read: connection refused')).toBe(
      true,
    );
    expect(isTransientGhError("Error: socket hang up")).toBe(true);
    expect(isTransientGhError("gh api call timed out (killed after 20000ms)")).toBe(true);
  });

  it("classifies rate-limit messaging as transient even when GitHub answers 403", () => {
    expect(isTransientGhError("gh: You have exceeded a secondary rate limit. (HTTP 403)")).toBe(
      true,
    );
  });

  it("classifies a genuine 404 tag-not-found as TERMINAL — it must never be retried", () => {
    expect(isTransientGhError("gh: Not Found (HTTP 404)")).toBe(false);
  });

  it("classifies other 4xx (401 / 403 / 422) as terminal (real provenance/auth problems)", () => {
    expect(isTransientGhError("gh: Bad credentials (HTTP 401)")).toBe(false);
    expect(isTransientGhError("gh: Forbidden (HTTP 403)")).toBe(false);
    expect(isTransientGhError("gh: Unprocessable Entity (HTTP 422)")).toBe(false);
  });

  it("classifies empty / unrecognized text as terminal (fail fast, do not mask)", () => {
    expect(isTransientGhError("")).toBe(false);
    expect(isTransientGhError("some unrelated failure")).toBe(false);
  });

  // --- Regression: issue #2184 / Sentinel A1 (attacker-influenced text) -----
  // The flattened blob can carry the ECHOED command line whose owner/repo/tag
  // come straight from an attacker-editable workflow `uses:` line. The HTTP
  // status MUST be parsed first and decide terminality on its own, so a
  // transient-sounding name can never turn a terminal 4xx into a retry.
  it("parses the HTTP status FIRST — an echoed transient-sounding owner/repo cannot flip a 404 to transient", () => {
    // owner literally contains the word "timeout" — a real HTTP 404 must win.
    expect(
      isTransientGhError("gh api repos/evil-timeout/foo/git/ref/tags/v1\ngh: Not Found (HTTP 404)"),
    ).toBe(false);
    // repo "rate-limit" and a "503-"-prefixed name must not read as transient.
    expect(
      isTransientGhError("gh api repos/acme/rate-limit/git/ref/tags/v1\ngh: Not Found (HTTP 404)"),
    ).toBe(false);
    expect(
      isTransientGhError("gh api repos/o/503-rate-limit/git/ref/tags/v1\ngh: Not Found (HTTP 404)"),
    ).toBe(false);
  });

  it("still classifies a real 429/5xx transient even when the echoed name looks terminal", () => {
    expect(isTransientGhError("gh api repos/not-found/gone/git/ref/tags/v1\ngh: (HTTP 429)")).toBe(
      true,
    );
    expect(
      isTransientGhError("gh api repos/bad-credentials/x/git/ref/tags/v1\ngh: (HTTP 503)"),
    ).toBe(true);
  });
});

describe("ghErrorText", () => {
  it("marks an execFile timeout kill as timed-out so it classifies transient", () => {
    const timeoutErr = Object.assign(new Error("Command failed: gh api repos/o/r"), {
      killed: true,
      signal: "SIGTERM",
    });
    const text = ghErrorText(timeoutErr);
    expect(text).toMatch(/timed out/i);
    expect(isTransientGhError(text)).toBe(true);
  });

  it("surfaces stderr so HTTP-status classification works on a gh failure", () => {
    const httpErr = Object.assign(new Error("Command failed: gh api repos/o/r/git/ref/tags/v9"), {
      stderr: "gh: Not Found (HTTP 404)",
      code: 1,
    });
    const text = ghErrorText(httpErr);
    expect(text).toContain("HTTP 404");
    expect(isTransientGhError(text)).toBe(false);
  });

  it("surfaces a string syscall code (e.g. ETIMEDOUT) for network failures", () => {
    const netErr = Object.assign(new Error("request failed"), { code: "ETIMEDOUT" });
    expect(isTransientGhError(ghErrorText(netErr))).toBe(true);
  });

  // --- Regression: issue #2184 / Sentinel A1 (attacker-influenced text) -----
  // Node's execFile puts the ECHOED command line ("Command failed: gh api
  // repos/<owner>/<repo>/...") into `err.message`. That owner/repo/tag is
  // attacker-editable via a workflow `uses:` line, so it must NOT feed the
  // transient/terminal classifier: a terminal 404 whose owner is
  // `evil-timeout` must stay TERMINAL.
  it("excludes the echoed command line (attacker owner/repo/tag) from the classified text", () => {
    const err = Object.assign(
      new Error(
        "Command failed: gh api repos/evil-timeout/foo/git/ref/tags/v1\ngh: Not Found (HTTP 404)\n",
      ),
      { stderr: "gh: Not Found (HTTP 404)\n", code: 1, killed: false },
    );
    const text = ghErrorText(err);
    expect(text).toContain("HTTP 404");
    expect(text).not.toMatch(/timeout/i);
    expect(isTransientGhError(text)).toBe(false);
  });

  // --- Regression: issue #2187 item 1 (Sentinel A1) -------------------------
  // When NO gh/OS-generated field is present (no stderr/stdout, no string
  // syscall code, not killed), the old empty-parts fallback returned
  // String(error), which re-exposes Node's echoed "Command failed: gh api
  // repos/<owner>/<repo>/..." line. That owner/repo/tag is attacker-editable via
  // a workflow `uses:` line, so it must never re-enter the classifier text — a
  // `timeout`-named owner must not read as a transient fault. Fail-closed: with
  // no diagnostic signal the fallback text classifies TERMINAL.
  it("does not re-admit the echoed command line in the no-gh-field fallback", () => {
    const err = new Error("Command failed: gh api repos/evil-timeout/foo/git/ref/tags/v1");
    const text = ghErrorText(err);
    expect(text).not.toMatch(/timeout/i);
    expect(text).not.toContain("Command failed");
    expect(text).not.toContain("evil-timeout");
    expect(isTransientGhError(text)).toBe(false);
  });
});

describe("formatFatalError", () => {
  // The top-level fatal handler (outside the per-pin loop) logs a caught error's
  // stack/message. That text can transitively include attacker-editable workflow
  // content — e.g. a control-char-laden `uses:` filename surfaced through a
  // readFile/parse error — so it must be sanitized to a single safe CI-log line
  // before it is written (issue #2181, Sentinel A1 digest item 3). This mirrors
  // the per-pin error sanitization already applied inside main().
  it("strips ANSI/OSC and C0/C1 control bytes from a fatal Error's stack/message", () => {
    const err = new Error("boom \x1B[31mred\x1B[0m \x07 \x9B done");
    const out = formatFatalError(err);
    expect(out).not.toContain("\x1B");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x9B");
    expect(out).toContain("boom");
  });

  it("folds a multi-line stack/message to one line (no CR/LF/LS break-out)", () => {
    const err = new Error("line1\r\nline2\u2028line3");
    const out = formatFatalError(err);
    expect(out).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it("stringifies and sanitizes a non-Error thrown value", () => {
    expect(formatFatalError("plain\x1B[2Jstring")).toBe("plainstring");
  });
});

describe("computeBackoffDelay", () => {
  it("grows exponentially from the base delay (full-window at random()=1)", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 100_000, random: () => 1 };
    expect(computeBackoffDelay(1, opts)).toBe(100);
    expect(computeBackoffDelay(2, opts)).toBe(200);
    expect(computeBackoffDelay(3, opts)).toBe(400);
    expect(computeBackoffDelay(4, opts)).toBe(800);
  });

  it("caps the exponential window at maxDelayMs", () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 3000, random: () => 1 };
    expect(computeBackoffDelay(10, opts)).toBe(3000);
  });

  it("applies bounded jitter within [0, window) from the injected random source", () => {
    // attempt 3 window = 1000 * 2^2 = 4000; floor(0.25 * 4000) = 1000.
    expect(
      computeBackoffDelay(3, { baseDelayMs: 1000, maxDelayMs: 100_000, random: () => 0.25 }),
    ).toBe(1000);
    expect(computeBackoffDelay(1, { baseDelayMs: 500, maxDelayMs: 8000, random: noJitter })).toBe(
      0,
    );
  });
});

describe("withRetry", () => {
  it("retries a transient failure and returns the eventual success (transient-then-success)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new Error("HTTP 503"));
        return Promise.resolve("ok");
      },
      {
        attempts: 4,
        isRetryable: () => true,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        random: noJitter,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // Slept exactly twice: before attempt 2 and before attempt 3.
    expect(sleeps).toHaveLength(2);
  });

  it("throws the last error after exhausting a bounded number of attempts", async () => {
    let calls = 0;
    let slept = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error(`HTTP 500 #${calls}`));
        },
        {
          attempts: 3,
          isRetryable: () => true,
          sleep: () => {
            slept += 1;
            return Promise.resolve();
          },
          random: noJitter,
        },
      ),
    ).rejects.toThrow("HTTP 500 #3");
    expect(calls).toBe(3);
    expect(slept).toBe(2);
  });

  it("does NOT retry a terminal failure — fails fast on the first attempt", async () => {
    let calls = 0;
    let slept = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
        },
        {
          attempts: 4,
          isRetryable: (error: unknown) => isTransientGhError(String(error)),
          sleep: () => {
            slept += 1;
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("HTTP 404");
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });
});

describe("ghApiJson (injected executor)", () => {
  it("passes the per-call timeout to the executor and parses stdout JSON", async () => {
    const seen: { path: string; timeoutMs: number }[] = [];
    const exec = (path: string, timeoutMs: number) => {
      seen.push({ path, timeoutMs });
      return Promise.resolve({ stdout: JSON.stringify({ ok: true }) });
    };
    const json = await ghApiJson("repos/o/r/git/ref/tags/v1", { exec, timeoutMs: 12345 });
    expect(json).toEqual({ ok: true });
    expect(seen).toEqual([{ path: "repos/o/r/git/ref/tags/v1", timeoutMs: 12345 }]);
  });

  it("retries a transient executor failure, then parses the eventual success", async () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("gh: Bad Gateway (HTTP 502)"));
      return Promise.resolve({ stdout: JSON.stringify({ sha: "abc" }) });
    };
    const json = await ghApiJson("repos/o/r", { exec, sleep: noSleep, random: noJitter });
    expect(json).toEqual({ sha: "abc" });
    expect(calls).toBe(2);
  });

  it("does not retry a 404 and rejects immediately", async () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
    };
    await expect(
      ghApiJson("repos/o/r/git/ref/tags/nope", { exec, sleep: noSleep }),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });
});

describe("resolveTagToCommit (injected executor)", () => {
  const lightweightRef = (sha: string) => JSON.stringify({ object: { type: "commit", sha } });

  it("resolves a lightweight tag directly to its (lowercased) commit SHA", async () => {
    const SHA = "AABBCCDDEEFF00112233445566778899AABBCCDD";
    const exec = () => Promise.resolve({ stdout: lightweightRef(SHA) });
    const commit = await resolveTagToCommit("actions", "checkout", "v7.0.0", { exec });
    expect(commit).toBe(SHA.toLowerCase());
  });

  it("dereferences an annotated tag object to the underlying commit", async () => {
    const TAG_SHA = "1111111111111111111111111111111111111111";
    const COMMIT_SHA = "2222222222222222222222222222222222222222";
    const exec = (path: string) => {
      if (path.includes("/git/ref/tags/")) {
        return Promise.resolve({
          stdout: JSON.stringify({ object: { type: "tag", sha: TAG_SHA } }),
        });
      }
      return Promise.resolve({
        stdout: JSON.stringify({ object: { type: "commit", sha: COMMIT_SHA } }),
      });
    };
    const commit = await resolveTagToCommit("o", "r", "v1.0.0", { exec });
    expect(commit).toBe(COMMIT_SHA);
  });

  it("retries a transient failure mid-resolution, then resolves the commit", async () => {
    let calls = 0;
    const COMMIT_SHA = "3333333333333333333333333333333333333333";
    const exec = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("gh: Service Unavailable (HTTP 503)"));
      return Promise.resolve({ stdout: lightweightRef(COMMIT_SHA) });
    };
    const commit = await resolveTagToCommit("o", "r", "v1", {
      exec,
      sleep: noSleep,
      random: noJitter,
    });
    expect(commit).toBe(COMMIT_SHA);
    expect(calls).toBe(2);
  });

  it("fails fast without retrying when the tag ref returns 404 (real mismatch)", async () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
    };
    await expect(resolveTagToCommit("o", "r", "v9.9.9", { exec, sleep: noSleep })).rejects.toThrow(
      /HTTP 404/,
    );
    expect(calls).toBe(1);
  });
});

// --- Regression: issue #2184 / Sentinel A1 --------------------------------
// End-to-end through the real `isRetryable: isTransientGhError(ghErrorText(e))`
// wiring, using an execFileAsync-shaped rejection (echoed command in
// `message`, HTTP status in `stderr`, numeric exit `code`). A terminal 404
// whose action name carries a transient-sounding word must fail FAST (exec
// called once, zero sleeps); genuinely transient faults must still be retried.
describe("gh api retry — attacker-controlled action name cannot force a retry (issue #2184)", () => {
  // Mirrors what `promisify(execFile)` rejects with on a non-zero `gh` exit.
  const ghExitError = (apiPath: string, stderr: string) =>
    Object.assign(new Error(`Command failed: gh api ${apiPath}\n${stderr}\n`), {
      stderr: `${stderr}\n`,
      code: 1,
      killed: false,
    });

  it("does NOT retry a 404 whose owner carries a transient-sounding word (exec once, zero sleeps)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const path = "repos/evil-timeout/foo/git/ref/tags/v1";
    const exec = () => {
      calls += 1;
      return Promise.reject(ghExitError(path, "gh: Not Found (HTTP 404)"));
    };
    await expect(
      ghApiJson(path, {
        exec,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("does NOT retry a plain 404 with a benign name (regression guard)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const path = "repos/actions/checkout/git/ref/tags/v9.9.9";
    const exec = () => {
      calls += 1;
      return Promise.reject(ghExitError(path, "gh: Not Found (HTTP 404)"));
    };
    await expect(
      ghApiJson(path, {
        exec,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("RETRIES a 429 rate-limit transient fault", async () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(ghExitError("repos/o/r", "gh: API rate limit exceeded (HTTP 429)"));
      }
      return Promise.resolve({ stdout: JSON.stringify({ ok: true }) });
    };
    const json = await ghApiJson("repos/o/r", { exec, sleep: noSleep, random: noJitter });
    expect(json).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("RETRIES an HTTP 5xx transient fault", async () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(ghExitError("repos/o/r", "gh: Service Unavailable (HTTP 503)"));
      }
      return Promise.resolve({ stdout: JSON.stringify({ ok: true }) });
    };
    const json = await ghApiJson("repos/o/r", { exec, sleep: noSleep, random: noJitter });
    expect(json).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("RETRIES a genuine network fault with no HTTP status (ETIMEDOUT / ECONNRESET)", async () => {
    for (const syscall of ["ETIMEDOUT", "ECONNRESET"]) {
      let calls = 0;
      const exec = () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            Object.assign(new Error("Command failed: gh api repos/o/r"), {
              code: syscall,
              killed: false,
            }),
          );
        }
        return Promise.resolve({ stdout: JSON.stringify({ ok: true }) });
      };
      const json = await ghApiJson("repos/o/r", { exec, sleep: noSleep, random: noJitter });
      expect(json).toEqual({ ok: true });
      expect(calls).toBe(2);
    }
  });
});

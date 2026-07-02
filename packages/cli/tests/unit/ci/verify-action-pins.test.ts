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
  normalizeTag,
  parseActionPins,
  toSingleLineDisplay,
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

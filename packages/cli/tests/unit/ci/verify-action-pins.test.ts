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
// purely for its pure parsing exports.
import { normalizeTag, parseActionPins } from "../../../../../scripts/verify-action-pins.mjs";

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

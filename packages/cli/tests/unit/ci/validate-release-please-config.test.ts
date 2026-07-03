/**
 * Unit tests for the release-please v5 config/manifest validator.
 *
 * The validator (`scripts/validate-release-please-config.mjs`) is a PR-time
 * guard for issue #623: the Release workflow only runs post-merge on `main`,
 * so a `release-please-config.json` / `.release-please-manifest.json` that is
 * incompatible with release-please-action v5 (release-please core v17) would
 * otherwise only surface AFTER merge. These tests pin the invariants the guard
 * enforces so a future edit that weakens them fails loudly.
 *
 * The known-key / known-release-type allowlists are derived from the
 * release-please v17 `ManifestConfig` / `ReleaserConfigJson` / `ReleaserPackageConfig`
 * source of truth (see the validator's header comment), NOT the published JSON
 * schema — the schema omits accepted keys such as `component`.
 */
import { describe, expect, it } from "vitest";

import {
  KNOWN_RELEASE_TYPES,
  isPathWithinRoot,
  isValidSemver,
  validateReleasePleaseConfig,
} from "../../../../../scripts/validate-release-please-config.mjs";

/** A minimal config/manifest pair that mirrors the repo's real, valid files. */
function validPair() {
  const config = {
    $schema:
      "https://raw.githubusercontent.com/googleapis/release-please/v17.1.1/schemas/config.json",
    "bootstrap-sha": "a3c1ff6942d7cf8a95daaf2bd4f85b31affcc778",
    packages: {
      "packages/cli": {
        "release-type": "node",
        component: "cli",
        "include-component-in-tag": true,
        "bump-minor-pre-major": true,
        "bump-patch-for-minor-pre-major": false,
        "changelog-sections": [{ type: "feat", section: "Features" }],
      },
    },
  };
  const manifest = { "packages/cli": "0.5.0" };
  return { config, manifest };
}

describe("validateReleasePleaseConfig", () => {
  it("accepts the current valid config/manifest pair", () => {
    const { config, manifest } = validPair();
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a config that uses `component` (accepted by v17 but absent from the JSON schema)", () => {
    // Independent of validPair(): a minimal single-package config whose only
    // schema-absent keys are `component` + `include-component-in-tag`, so this
    // test uniquely pins acceptance of `component` rather than duplicating the
    // valid-pair fixture (issue #2181 digest item 9, 5a).
    const config = {
      packages: {
        "packages/core": {
          "release-type": "node",
          component: "core",
          "include-component-in-tag": true,
        },
      },
    };
    const manifest = { "packages/core": "1.2.3" };
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a config package with no corresponding manifest entry", () => {
    const { config, manifest } = validPair();
    config.packages["packages/new-pkg"] = { "release-type": "node" };
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("packages/new-pkg"))).toBe(true);
  });

  it("rejects a manifest entry with no corresponding config package", () => {
    const { config, manifest } = validPair();
    (manifest as Record<string, string>)["packages/ghost"] = "1.0.0";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("packages/ghost"))).toBe(true);
  });

  it("rejects a manifest version that is not valid semver", () => {
    const { config, manifest } = validPair();
    manifest["packages/cli"] = "not-a-version";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  it("rejects an invalid release-type", () => {
    const { config, manifest } = validPair();
    config.packages["packages/cli"]["release-type"] = "nodejs";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("release-type"))).toBe(true);
  });

  it("rejects an invalid root-level release-type", () => {
    const { config, manifest } = validPair();
    (config as Record<string, unknown>)["release-type"] = "not-a-real-type";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid root release-type"))).toBe(true);
  });

  it("accepts a valid root-level release-type", () => {
    const { config, manifest } = validPair();
    (config as Record<string, unknown>)["release-type"] = "node";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an unknown root-level key (e.g. a v4-only / typo key)", () => {
    const { config, manifest } = validPair();
    (config as Record<string, unknown>)["release-typ"] = "node";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("release-typ"))).toBe(true);
  });

  it("rejects an unknown per-package key", () => {
    const { config, manifest } = validPair();
    (config.packages["packages/cli"] as Record<string, unknown>)["releas-type"] = "node";
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("releas-type"))).toBe(true);
  });

  it("rejects a config missing the required `packages` key", () => {
    const { manifest } = validPair();
    const result = validateReleasePleaseConfig({}, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("packages"))).toBe(true);
  });

  it("rejects an empty `packages` object", () => {
    const result = validateReleasePleaseConfig({ packages: {} }, {});
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("packages"))).toBe(true);
  });

  it("rejects non-object config or manifest inputs", () => {
    expect(validateReleasePleaseConfig(null, {}).ok).toBe(false);
    expect(validateReleasePleaseConfig({ packages: {} }, null).ok).toBe(false);
    expect(validateReleasePleaseConfig([], {}).ok).toBe(false);
  });

  it("accumulates multiple errors rather than throwing", () => {
    const config = {
      "release-typ": "node",
      packages: { "packages/cli": { "release-type": "bogus" } },
    };
    const manifest = { "packages/cli": "bad", "packages/extra": "1.0.0" };
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    // Four independent faults (unknown root key, invalid release-type, invalid
    // manifest semver, orphan manifest entry) must all surface — the old
    // `toBeGreaterThan(1)` under-ratcheted a 4-fault input (issue #2181 item 9, 5b).
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  // --- Regression: issue #2181 digest item 6 (Sentinel A1, log-sanitization) --
  // A fork PR can place ANSI/OSC/C0/C1 escape bytes inside a JSON config key or
  // value; the validator echoes offending keys/values into its error strings,
  // which are later written to the Actions log. Untrusted JSON-derived text must
  // be stripped of terminal-control/escape bytes before it reaches the log so it
  // cannot spoof or manipulate the terminal. The RAW value is still (correctly)
  // used for the validity decision — only the DISPLAYED error text is sanitized.
  it("strips ANSI/control bytes from an untrusted config KEY echoed in an error", () => {
    const config = {
      packages: { "packages/cli": { "release-type": "node" } },
      "\u001B[31mmalicious\u001B[0m\u0007": true,
    };
    const manifest = { "packages/cli": "0.5.0" };
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).not.toContain("\u001B");
    expect(joined).not.toContain("\u0007");
    // The sanitized key text is still surfaced so the maintainer can locate it.
    expect(joined).toContain("malicious");
  });

  it("strips ANSI/control bytes from an untrusted release-type VALUE echoed in an error", () => {
    const config = { packages: { "packages/cli": { "release-type": "no\u001B[31mde-x" } } };
    const manifest = { "packages/cli": "0.5.0" };
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).not.toContain("\u001B");
  });

  it("strips control bytes from an untrusted manifest PATH echoed in an error", () => {
    const config = { packages: { "packages/cli": { "release-type": "node" } } };
    const manifest = { "packages/cli": "0.5.0", "pkg\u001B[31mghost\r\n[fake ok]": "1.0.0" };
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).not.toContain("\u001B");
    expect(joined).not.toMatch(/\r/);
  });
});

describe("KNOWN_RELEASE_TYPES", () => {
  it("includes the strategies release-please v17 registers", () => {
    expect(KNOWN_RELEASE_TYPES.has("node")).toBe(true);
    expect(KNOWN_RELEASE_TYPES.has("simple")).toBe(true);
    expect(KNOWN_RELEASE_TYPES.has("go")).toBe(true);
  });

  it("does not include invalid/typo strategy names", () => {
    expect(KNOWN_RELEASE_TYPES.has("nodejs")).toBe(false);
    expect(KNOWN_RELEASE_TYPES.has("")).toBe(false);
  });
});

describe("isValidSemver", () => {
  it("accepts valid semver strings", () => {
    expect(isValidSemver("0.5.0")).toBe(true);
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("2.3.4-alpha.1")).toBe(true);
    expect(isValidSemver("1.2.3+build.5")).toBe(true);
  });

  it("rejects invalid semver strings and non-strings", () => {
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("v1.2.3")).toBe(false);
    expect(isValidSemver("not-a-version")).toBe(false);
    expect(isValidSemver("")).toBe(false);
    expect(isValidSemver(123)).toBe(false);
    expect(isValidSemver(null)).toBe(false);
    expect(isValidSemver(undefined)).toBe(false);
  });
});

describe("isPathWithinRoot", () => {
  // Defense-in-depth for issue #2181 digest item 7: the validator resolves its
  // config/manifest paths from positional CLI args. The shipped workflow passes
  // none (defaults under the repo root), but a supplied path must never escape
  // the repo root via `..`, an absolute path, or a sibling-prefix look-alike.
  it("accepts a path at, or nested under, the repo root", () => {
    expect(isPathWithinRoot("/repo", "/repo")).toBe(true);
    expect(isPathWithinRoot("/repo/release-please-config.json", "/repo")).toBe(true);
    expect(isPathWithinRoot("/repo/a/b/c.json", "/repo")).toBe(true);
  });

  it("rejects traversal escapes, absolute escapes, and sibling-prefix look-alikes", () => {
    expect(isPathWithinRoot("/repo/../etc/passwd", "/repo")).toBe(false);
    expect(isPathWithinRoot("/etc/passwd", "/repo")).toBe(false);
    // "/repo-evil" must not pass a naive `startsWith("/repo")` prefix check.
    expect(isPathWithinRoot("/repo-evil/secret", "/repo")).toBe(false);
  });
});

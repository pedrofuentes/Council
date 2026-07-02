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
    const { config, manifest } = validPair();
    const result = validateReleasePleaseConfig(config, manifest);
    expect(result.ok).toBe(true);
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
    expect(result.errors.length).toBeGreaterThan(1);
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

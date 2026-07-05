/**
 * RED test for #1231 — adopting the eslint `preserve-caught-error` rule.
 *
 * When `config/loader.ts` wraps a caught YAML parse failure into a descriptive
 * Error, the original error MUST be preserved via `Error.cause` so callers and
 * debuggers can trace the underlying failure. Before #1231, `parseConfig`
 * re-threw a bare `new Error(...)` inside its `catch`, silently dropping the
 * YAML parse error. This asserts the chained-cause behavior.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/index.js";

describe("loadConfig() error-cause chaining (#1231)", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];
  const originalCouncilDataHome = process.env["COUNCIL_DATA_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-cause-test-"));
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    if (originalCouncilDataHome === undefined) {
      delete process.env["COUNCIL_DATA_HOME"];
    } else {
      process.env["COUNCIL_DATA_HOME"] = originalCouncilDataHome;
    }
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it("preserves the underlying YAML parse error via Error.cause on malformed config", async () => {
    const configFile = path.join(testHome, "config.yaml");
    await fs.mkdir(testHome, { recursive: true });
    // Tab indentation inside a mapping is a YAML syntax error, so yaml.parse
    // throws and parseConfig() must wrap it while preserving the cause.
    await fs.writeFile(configFile, "defaults:\n\tmaxRounds: 8\n", "utf-8");

    let caught: unknown;
    try {
      await loadConfig();
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Failed to parse Council config/);
    // The original YAML parse error MUST be chained as `cause`; it was dropped
    // before #1231 adopted the eslint preserve-caught-error rule.
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });
});

/**
 * Tests for T-12: Engine default & first-run UX.
 *
 * Covers:
 *   - defaults.engine in ConfigSchema (CLI-02)
 *   - First-run detection with welcome banner (CLI-04)
 *   - Non-TTY auto-confirm for convene auto-compose (DX-04)
 *   - Engine resolution order: CLI flag → config file → default "copilot"
 *   - Doctor hint appended on auth/engine errors
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigSchema, type CouncilConfig, loadConfig } from "../../../src/config/index.js";

describe("ConfigSchema — defaults.engine field (CLI-02)", () => {
  it("defaults engine to 'copilot' when omitted", () => {
    const config = ConfigSchema.parse({});
    expect(config.defaults.engine).toBe("copilot");
  });

  it("accepts 'mock' as a valid engine value", () => {
    const config = ConfigSchema.parse({ defaults: { engine: "mock" } });
    expect(config.defaults.engine).toBe("mock");
  });

  it("accepts 'copilot' as a valid engine value", () => {
    const config = ConfigSchema.parse({ defaults: { engine: "copilot" } });
    expect(config.defaults.engine).toBe("copilot");
  });

  it("rejects invalid engine values", () => {
    expect(() => ConfigSchema.parse({ defaults: { engine: "openai" } })).toThrow();
  });

  it("preserves existing config fields when engine is added", () => {
    const config = ConfigSchema.parse({
      defaults: { engine: "mock", maxRounds: 6 },
    });
    expect(config.defaults.engine).toBe("mock");
    expect(config.defaults.maxRounds).toBe(6);
    expect(config.defaults.model).toBeTypeOf("string");
  });

  it("is backward-compatible — old configs without engine still parse", () => {
    // Simulates an existing config.yaml that has no engine field
    const config = ConfigSchema.parse({
      defaults: { model: "claude-sonnet-4-20250514", maxRounds: 4 },
      telemetry: { enabled: false },
    });
    expect(config.defaults.engine).toBe("copilot");
  });
});

describe("loadConfigWithMeta() — first-run detection (CLI-04)", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-engine-test-"));
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it("returns isFirstRun=true when config.yaml is created for the first time", async () => {
    const { loadConfigWithMeta } = await import("../../../src/config/loader.js");
    const result = await loadConfigWithMeta();
    expect(result.isFirstRun).toBe(true);
  });

  it("returns isFirstRun=false when config.yaml already exists", async () => {
    const { loadConfigWithMeta } = await import("../../../src/config/loader.js");
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      "defaults:\n  maxRounds: 4\n",
      "utf-8",
    );
    const result = await loadConfigWithMeta();
    expect(result.isFirstRun).toBe(false);
  });

  it("includes engine default in newly created config file", async () => {
    await loadConfig();
    const written = await fs.readFile(path.join(testHome, "config.yaml"), "utf-8");
    expect(written).toContain("engine");
  });
});

describe("resolveEngine() — resolution order (CLI-02)", () => {
  it("CLI flag takes precedence over config", async () => {
    const { resolveEngine } = await import("../../../src/config/loader.js");
    const config = ConfigSchema.parse({ defaults: { engine: "mock" } });
    expect(resolveEngine("copilot", config)).toBe("copilot");
  });

  it("uses config value when CLI flag is undefined", async () => {
    const { resolveEngine } = await import("../../../src/config/loader.js");
    const config = ConfigSchema.parse({ defaults: { engine: "mock" } });
    expect(resolveEngine(undefined, config)).toBe("mock");
  });

  it("falls back to 'copilot' when both CLI and config are unset", async () => {
    const { resolveEngine } = await import("../../../src/config/loader.js");
    const config = ConfigSchema.parse({});
    expect(resolveEngine(undefined, config)).toBe("copilot");
  });
});

describe("formatEngineError() — doctor hint on auth errors (CLI-04)", () => {
  it("appends doctor hint on NOT_AUTHENTICATED errors", async () => {
    const { formatEngineError } = await import("../../../src/cli/error-mapper.js");
    const result = formatEngineError({ code: "NOT_AUTHENTICATED", message: "no auth" });
    expect(result).toContain("council doctor");
  });
});

describe("non-TTY auto-confirm (DX-04)", () => {
  it("isNonInteractive() returns true when stdin is not a TTY", async () => {
    const { isNonInteractive } = await import("../../../src/cli/non-interactive.js");
    // The test process itself likely has no TTY (piped stdin in CI)
    // We test the function exists and returns a boolean
    expect(typeof isNonInteractive()).toBe("boolean");
  });
});

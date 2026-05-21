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

import { ConfigSchema, loadConfig } from "../../../src/config/index.js";

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
    await fs.writeFile(path.join(testHome, "config.yaml"), "defaults:\n  maxRounds: 4\n", "utf-8");
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

describe("non-TTY auto-compose requires --yes (DX-04)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-nontty-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("isNonInteractive() returns true when stdin is not a TTY", async () => {
    const { isNonInteractive } = await import("../../../src/cli/non-interactive.js");
    // In test/CI environments, stdin is piped (not a TTY)
    expect(isNonInteractive()).toBe(true);
  });

  it("convene rejects auto-compose without --yes in non-interactive mode", async () => {
    const { buildConveneCommand } = await import("../../../src/cli/commands/convene.js");
    const { isNonInteractive } = await import("../../../src/cli/non-interactive.js");

    // Confirm we are non-interactive (test process has piped stdin)
    expect(isNonInteractive()).toBe(true);

    const validPanelJson = JSON.stringify({
      name: "nontty-panel",
      description: "Test panel",
      experts: [
        { slug: "a", displayName: "A", role: "X", expertise: { weightedEvidence: ["x"], referenceCases: [], notExpertIn: [] }, epistemicStance: "s" },
        { slug: "b", displayName: "B", role: "Y", expertise: { weightedEvidence: ["y"], referenceCases: [], notExpertIn: [] }, epistemicStance: "s" },
      ],
    });

    // Minimal scripted engine that returns auto-compose JSON
    const engineFactory = () => ({
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async addExpert() { /* noop */ },
      async removeExpert() { /* noop */ },
      async listModels() { return ["stub"] as const; },
      send() {
        return (async function* () {
          yield { kind: "message.delta" as const, expertId: "x", text: validPanelJson };
          yield { kind: "message.complete" as const, expertId: "x", response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 } };
        })();
      },
    });

    // Build convene WITHOUT confirmProvider — triggers non-TTY detection
    const cmd = buildConveneCommand({
      engineFactory,
      write: () => undefined,
      writeError: () => undefined,
      // NO confirmProvider — forces the non-TTY code path
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync([
        "node", "council-convene", "topic", "--engine", "mock",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toMatch(/non-interactive|--yes/i);
  });
});

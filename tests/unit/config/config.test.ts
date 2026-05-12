/**
 * Tests for the configuration system.
 *
 * Covers:
 *   - ConfigSchema parses minimal/partial/full YAML and returns typed CouncilConfig
 *   - Defaults are applied when fields are missing
 *   - Invalid values throw with descriptive errors (with the path)
 *   - loadConfig() creates ~/.council/config.yaml when missing
 *   - loadConfig() honors COUNCIL_HOME env var override (for tests + ephemeral mode)
 *   - getCouncilHome() returns the resolved home directory
 *
 * RED at this commit: src/config/* does not yet exist.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigSchema,
  type CouncilConfig,
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
} from "../../../src/config/index.js";

describe("ConfigSchema", () => {
  it("parses an empty object and applies all defaults", () => {
    const config: CouncilConfig = ConfigSchema.parse({});
    expect(config.defaults.model).toBeTypeOf("string");
    expect(config.defaults.maxRounds).toBeGreaterThanOrEqual(1);
    expect(config.defaults.maxExperts).toBeGreaterThanOrEqual(2);
    expect(config.defaults.maxWordsPerResponse).toBeGreaterThan(0);
    expect(config.telemetry.enabled).toBe(false);
  });

  it("parses a partial config and merges with defaults", () => {
    const config = ConfigSchema.parse({
      defaults: { maxRounds: 6 },
    });
    expect(config.defaults.maxRounds).toBe(6);
    // Other defaults still applied:
    expect(config.defaults.maxExperts).toBeGreaterThanOrEqual(2);
  });

  it("parses a full config", () => {
    const config = ConfigSchema.parse({
      defaults: {
        model: "claude-opus-4",
        maxRounds: 10,
        maxExperts: 5,
        maxWordsPerResponse: 500,
      },
      telemetry: { enabled: true },
    });
    expect(config.defaults.model).toBe("claude-opus-4");
    expect(config.defaults.maxRounds).toBe(10);
    expect(config.defaults.maxExperts).toBe(5);
    expect(config.defaults.maxWordsPerResponse).toBe(500);
    expect(config.telemetry.enabled).toBe(true);
  });

  it("rejects out-of-range maxRounds", () => {
    expect(() => ConfigSchema.parse({ defaults: { maxRounds: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ defaults: { maxRounds: 999 } })).toThrow();
  });

  it("rejects out-of-range maxExperts", () => {
    expect(() => ConfigSchema.parse({ defaults: { maxExperts: 1 } })).toThrow();
    expect(() => ConfigSchema.parse({ defaults: { maxExperts: 99 } })).toThrow();
  });

  it("rejects out-of-range maxWordsPerResponse", () => {
    expect(() => ConfigSchema.parse({ defaults: { maxWordsPerResponse: 10 } })).toThrow();
    expect(() => ConfigSchema.parse({ defaults: { maxWordsPerResponse: 5000 } })).toThrow();
  });

  it("rejects wrong types", () => {
    expect(() => ConfigSchema.parse({ defaults: { maxRounds: "lots" } })).toThrow();
    expect(() => ConfigSchema.parse({ telemetry: { enabled: "yes" } })).toThrow();
  });

  it("applies defaults for new expert/chat/paths sections from empty input", () => {
    const config = ConfigSchema.parse({});
    expect(config.expert.backgroundProcessing).toBe(false);
    expect(config.expert.recencyHalfLifeDays).toBe(90);
    expect(config.expert.supportedFormats).toEqual([".md", ".txt", ".html"]);
    expect(config.chat.recentTurnCount).toBe(10);
    expect(config.chat.summaryMaxWords).toBe(500);
    expect(config.chat.longConversationWarning).toBe(500);
    expect(config.paths.dataHome).toBe("~/Council");
  });

  it("parses fully populated expert/chat/paths sections", () => {
    const config = ConfigSchema.parse({
      expert: {
        backgroundProcessing: true,
        recencyHalfLifeDays: 30,
        supportedFormats: [".md", ".pdf"],
      },
      chat: {
        recentTurnCount: 20,
        summaryMaxWords: 800,
        longConversationWarning: 1000,
      },
      paths: { dataHome: "/var/lib/council" },
    });
    expect(config.expert.backgroundProcessing).toBe(true);
    expect(config.expert.recencyHalfLifeDays).toBe(30);
    expect(config.expert.supportedFormats).toEqual([".md", ".pdf"]);
    expect(config.chat.recentTurnCount).toBe(20);
    expect(config.chat.summaryMaxWords).toBe(800);
    expect(config.chat.longConversationWarning).toBe(1000);
    expect(config.paths.dataHome).toBe("/var/lib/council");
  });

  it("rejects out-of-range chat.recentTurnCount", () => {
    expect(() => ConfigSchema.parse({ chat: { recentTurnCount: 4 } })).toThrow();
    expect(() => ConfigSchema.parse({ chat: { recentTurnCount: 51 } })).toThrow();
  });

  it("rejects out-of-range chat.summaryMaxWords", () => {
    expect(() => ConfigSchema.parse({ chat: { summaryMaxWords: 50 } })).toThrow();
    expect(() => ConfigSchema.parse({ chat: { summaryMaxWords: 9999 } })).toThrow();
  });

  it("rejects out-of-range expert.recencyHalfLifeDays", () => {
    expect(() => ConfigSchema.parse({ expert: { recencyHalfLifeDays: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ expert: { recencyHalfLifeDays: 9999 } })).toThrow();
  });

  it("rejects wrong types in expert section", () => {
    expect(() => ConfigSchema.parse({ expert: { backgroundProcessing: "yes" } })).toThrow();
  });
});

describe("loadConfig() / getCouncilHome() — file I/O", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"));
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

  it("getCouncilHome() returns the COUNCIL_HOME env var when set", () => {
    expect(getCouncilHome()).toBe(testHome);
  });

  it("getCouncilHome() defaults to ~/.council when COUNCIL_HOME is unset", () => {
    delete process.env["COUNCIL_HOME"];
    expect(getCouncilHome()).toBe(path.join(os.homedir(), ".council"));
  });

  it("loadConfig() creates a default config file when missing", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await expect(fs.access(configPath)).rejects.toThrow();

    const config = await loadConfig();

    expect(config.defaults.model).toBeTypeOf("string");
    await expect(fs.access(configPath)).resolves.toBeUndefined();
    const written = await fs.readFile(configPath, "utf-8");
    expect(written).toContain("defaults");
  });

  it("loadConfig() reads an existing YAML file and applies defaults", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      configPath,
      "defaults:\n  maxRounds: 8\ntelemetry:\n  enabled: true\n",
      "utf-8",
    );

    const config = await loadConfig();

    expect(config.defaults.maxRounds).toBe(8);
    expect(config.telemetry.enabled).toBe(true);
    // Unspecified fields take defaults:
    expect(config.defaults.maxExperts).toBeGreaterThanOrEqual(2);
  });

  it("loadConfig() throws a descriptive error on invalid YAML values", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      configPath,
      "defaults:\n  maxRounds: 999\n", // out of range (max 20)
      "utf-8",
    );

    await expect(loadConfig()).rejects.toThrow(/maxRounds/i);
  });

  it("getCouncilDataHome() returns COUNCIL_DATA_HOME env var when set", () => {
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_DATA_HOME"] = testHome;
    try {
      expect(getCouncilDataHome()).toBe(testHome);
    } finally {
      if (originalDataHome === undefined) {
        delete process.env["COUNCIL_DATA_HOME"];
      } else {
        process.env["COUNCIL_DATA_HOME"] = originalDataHome;
      }
    }
  });

  it("getCouncilDataHome() defaults to ~/Council when env unset and no config", () => {
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    delete process.env["COUNCIL_DATA_HOME"];
    try {
      expect(getCouncilDataHome()).toBe(path.join(os.homedir(), "Council"));
    } finally {
      if (originalDataHome !== undefined) {
        process.env["COUNCIL_DATA_HOME"] = originalDataHome;
      }
    }
  });

  it("getCouncilDataHome() expands ~ in config dataHome", () => {
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    delete process.env["COUNCIL_DATA_HOME"];
    try {
      const config = ConfigSchema.parse({ paths: { dataHome: "~/MyCouncil" } });
      expect(getCouncilDataHome(config)).toBe(path.join(os.homedir(), "MyCouncil"));
    } finally {
      if (originalDataHome !== undefined) {
        process.env["COUNCIL_DATA_HOME"] = originalDataHome;
      }
    }
  });

  it("getCouncilDataHome() returns absolute config dataHome verbatim", () => {
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    delete process.env["COUNCIL_DATA_HOME"];
    try {
      const abs = path.join(testHome, "data");
      const config = ConfigSchema.parse({ paths: { dataHome: abs } });
      expect(getCouncilDataHome(config)).toBe(abs);
    } finally {
      if (originalDataHome !== undefined) {
        process.env["COUNCIL_DATA_HOME"] = originalDataHome;
      }
    }
  });

  it("ensureDataDirectories() creates experts/ and panels/ subdirs", async () => {
    const dataHome = path.join(testHome, "data-home");
    await ensureDataDirectories(dataHome);
    await expect(fs.access(path.join(dataHome, "experts"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dataHome, "panels"))).resolves.toBeUndefined();
  });

  it("ensureDataDirectories() is idempotent", async () => {
    const dataHome = path.join(testHome, "data-home-idem");
    await ensureDataDirectories(dataHome);
    await expect(ensureDataDirectories(dataHome)).resolves.toBeUndefined();
  });

  it("loadConfig() throws a descriptive error on malformed YAML", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.mkdir(testHome, { recursive: true });
    // YAML syntax error: tab-indented inside mapping
    await fs.writeFile(configPath, "defaults:\n\tmaxRounds: 8\n", "utf-8");

    await expect(loadConfig()).rejects.toThrow();
  });
});

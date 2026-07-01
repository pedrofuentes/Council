/**
 * Tests for `council doctor`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDoctorCommand, checkNodeVersion } from "../../../../src/cli/commands/doctor.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface SpinnerLike {
  start(label: string): void;
  stop(): void;
}

interface DoctorDepsLike {
  readonly write?: Writer;
  readonly version?: string;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
  readonly onlineProbeTimeoutMs?: number;
  readonly discoverModels?: () => Promise<{
    models: readonly string[];
    source: "live" | "static";
  }>;
  readonly createSpinner?: () => SpinnerLike;
  readonly resolveCliPath?: () => string | undefined;
}

const buildDoctorCommandWithDeps = buildDoctorCommand as unknown as (
  deps: DoctorDepsLike,
) => ReturnType<typeof buildDoctorCommand>;

async function runDoctor(args: readonly string[], deps: DoctorDepsLike = {}): Promise<string> {
  let captured = "";
  const cmd = buildDoctorCommandWithDeps({
    ...deps,
    write: (chunk: string) => {
      captured += chunk;
    },
  });
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-doctor", ...args]).catch(() => undefined);
  return captured;
}

// Permission-based tests are meaningless when the process can bypass the mode
// bits (root) or when POSIX permissions do not apply (Windows).
const isPrivileged =
  process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);

describe("buildDoctorCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalCliPath: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    originalCliPath = process.env["COPILOT_CLI_PATH"];
    process.env["COUNCIL_HOME"] = testHome;
    delete process.env["COPILOT_CLI_PATH"];
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    if (originalCliPath === undefined) delete process.env["COPILOT_CLI_PATH"];
    else process.env["COPILOT_CLI_PATH"] = originalCliPath;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("doctor runs online check by default", async () => {
    const onlineProbe = vi.fn(async (model: string) => ({
      ok: true,
      detail: `probe ok for ${model}`,
    }));

    const output = await runDoctor([], { onlineProbe });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(onlineProbe).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(output).toContain("Default model (claude-sonnet-4.5) session created successfully");
  });

  it("doctor --online still works for backwards compatibility", async () => {
    const onlineProbe = vi.fn(async (model: string) => ({
      ok: true,
      detail: `probe ok for ${model}`,
    }));

    const output = await runDoctor(["--online"], { onlineProbe });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(onlineProbe).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(output).toContain("Default model (claude-sonnet-4.5) session created successfully");
  });

  it("doctor with failed probe shows alternatives and config set fix", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      "defaults:\n  engine: copilot\n  model: claude-sonnet-4-20250514\n  maxRounds: 4\n",
      "utf-8",
    );

    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "claude-sonnet-4.6", "gpt-5.4", "gpt-5.4-mini"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      "Default model (claude-sonnet-4-20250514) is not accessible: model not found",
    );
    expect(output).toContain("Available alternatives:");
    expect(output).toContain("claude-sonnet-4.5, claude-sonnet-4.6, gpt-5.4, gpt-5.4-mini");
    expect(output).toContain("Fix: council config set defaults.model claude-sonnet-4.5");
  });

  it("doctor with thrown probe still shows alternatives", async () => {
    const onlineProbe = vi.fn(async () => {
      throw new Error("session creation failed");
    });
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "gpt-5.4", "gpt-5.4-mini"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      "Default model (claude-sonnet-4.5) probe failed: session creation failed",
    );
    expect(output).toContain("Available alternatives:");
    expect(output).toContain("gpt-5.4, gpt-5.4-mini");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4");
  });

  it("doctor with failed probe degrades gracefully when model discovery throws", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => {
      throw new Error("discovery unavailable");
    });

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      "Default model (claude-sonnet-4.5) is not accessible: model not found",
    );
    expect(output).not.toContain("Available alternatives:");
    expect(output).not.toContain("discovery unavailable");
  });

  it("doctor bounds a hung online probe with a timeout instead of hanging", async () => {
    const onlineProbe = vi.fn(() => new Promise<{ ok: boolean; detail: string }>(() => undefined));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "gpt-5.4"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels, onlineProbeTimeoutMs: 50 });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(output).toContain("Default model (claude-sonnet-4.5) probe timed out");
    expect(output).toContain("Some checks failed");
  });

  it("doctor --offline skips model probe", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "should not run" }));

    const output = await runDoctor(["--offline"], { onlineProbe });

    expect(onlineProbe).not.toHaveBeenCalled();
    expect(output).toMatch(/Council v\d+\.\d+\.\d+/);
    expect(output).not.toContain("Default model (");
  });

  it("doctor displays the Council version", async () => {
    const output = await runDoctor(["--offline"], { version: "9.9.9" });

    expect(output).toContain("Council v9.9.9");
  });

  it("doctor no longer prints the old plain-text 'Council Doctor' header", async () => {
    const output = await runDoctor(["--offline"], { version: "9.9.9" });

    expect(output).not.toContain("Council Doctor");
  });

  it("doctor uses COUNCIL_DATA_HOME for visible paths when COUNCIL_HOME is unset", async () => {
    const customDataHome = path.join(testHome, "custom-data-home");
    delete process.env["COUNCIL_HOME"];
    process.env["COUNCIL_DATA_HOME"] = customDataHome;

    const output = await runDoctor(["--offline"]);

    expect(output).toContain(`Council home\n   ${customDataHome}`);
    expect(output).toContain(`Council data home\n   ${customDataHome}`);
    expect(output).toContain(`Path: ${path.join(customDataHome, "config.yaml")}`);
  });

  it("doctor creates the experts/ and panels/ directories under COUNCIL_DATA_HOME (#792)", async () => {
    const customDataHome = path.join(testHome, "custom-data-home");
    process.env["COUNCIL_DATA_HOME"] = customDataHome;

    await runDoctor(["--offline"]);

    const experts = await fs.stat(path.join(customDataHome, "experts"));
    const panels = await fs.stat(path.join(customDataHome, "panels"));
    expect(experts.isDirectory()).toBe(true);
    expect(panels.isDirectory()).toBe(true);
  });

  it("doctor falls back to the env data home when config load fails (#785)", async () => {
    const customDataHome = path.join(testHome, "fallback-data-home");
    process.env["COUNCIL_DATA_HOME"] = customDataHome;
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(path.join(testHome, "config.yaml"), "{{invalid yaml", "utf-8");

    const output = await runDoctor(["--offline"]);

    // loadConfig() throws on the broken YAML, so resolveDoctorDataHome() takes the
    // catch branch and still resolves the data home from COUNCIL_DATA_HOME.
    expect(output).toContain(`Council data home\n   ${customDataHome}`);
    expect(output).toContain("Could not load configuration");
    const experts = await fs.stat(path.join(customDataHome, "experts"));
    expect(experts.isDirectory()).toBe(true);
  });

  it("doctor reports failure when the Council data home cannot be created (#785)", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const blocker = path.join(testHome, "blocker-file");
    await fs.writeFile(blocker, "not a directory", "utf-8");
    const unmakeableDataHome = path.join(blocker, "nested-data-home");
    process.env["COUNCIL_DATA_HOME"] = unmakeableDataHome;

    const output = await runDoctor(["--offline"]);

    expect(output).toContain(`cannot create ${unmakeableDataHome}`);
    expect(output).toContain("Some checks failed");
  });

  it.skipIf(isPrivileged)(
    "doctor fails the data home check when the directory exists but is not writable (#793)",
    async () => {
      const customDataHome = path.join(testHome, "readonly-data-home");
      await fs.mkdir(path.join(customDataHome, "experts"), { recursive: true });
      await fs.mkdir(path.join(customDataHome, "panels"), { recursive: true });
      process.env["COUNCIL_DATA_HOME"] = customDataHome;
      await fs.chmod(customDataHome, 0o500);

      try {
        const output = await runDoctor(["--offline"]);

        // ensureDataDirectories() is a no-op on the existing subdirs, so creation
        // "passes"; only a real write probe surfaces the read-only directory.
        expect(output).toContain(`cannot write under ${customDataHome}`);
        expect(output).toContain("Some checks failed");
      } finally {
        await fs.chmod(customDataHome, 0o700);
      }
    },
  );

  it.skipIf(isPrivileged)(
    "doctor fails the data home check when the experts/ write target is not writable (#1914)",
    async () => {
      const customDataHome = path.join(testHome, "experts-readonly-data-home");
      await fs.mkdir(path.join(customDataHome, "experts"), { recursive: true });
      await fs.mkdir(path.join(customDataHome, "panels"), { recursive: true });
      process.env["COUNCIL_DATA_HOME"] = customDataHome;
      // Root and panels/ stay writable; only the experts/ runtime write target
      // is read-only. A root-only probe would report a false-green here even
      // though the first real expert save would fail at runtime.
      await fs.chmod(path.join(customDataHome, "experts"), 0o500);

      try {
        const output = await runDoctor(["--offline"]);

        expect(output).toContain(`cannot write under ${path.join(customDataHome, "experts")}`);
        expect(output).toContain("Some checks failed");
      } finally {
        await fs.chmod(path.join(customDataHome, "experts"), 0o700);
      }
    },
  );

  it.skipIf(isPrivileged)(
    "doctor fails the data home check when the panels/ write target is not writable (#1914)",
    async () => {
      const customDataHome = path.join(testHome, "panels-readonly-data-home");
      await fs.mkdir(path.join(customDataHome, "experts"), { recursive: true });
      await fs.mkdir(path.join(customDataHome, "panels"), { recursive: true });
      process.env["COUNCIL_DATA_HOME"] = customDataHome;
      // Root and experts/ stay writable; only the panels/ runtime write target
      // is read-only, exercising the second subdirectory in the write class.
      await fs.chmod(path.join(customDataHome, "panels"), 0o500);

      try {
        const output = await runDoctor(["--offline"]);

        expect(output).toContain(`cannot write under ${path.join(customDataHome, "panels")}`);
        expect(output).toContain("Some checks failed");
      } finally {
        await fs.chmod(path.join(customDataHome, "panels"), 0o700);
      }
    },
  );

  it("doctor passes the data home check when root, experts/ and panels/ are all writable (#1914)", async () => {
    const customDataHome = path.join(testHome, "writable-data-home");
    process.env["COUNCIL_DATA_HOME"] = customDataHome;

    const output = await runDoctor(["--offline"]);

    expect(output).toContain(`Council data home\n   ${customDataHome}`);
    expect(output).not.toContain("cannot write under");
  });

  it("doctor collapses control characters in Terminal env values onto one line (#1483)", async () => {
    const customDataHome = path.join(testHome, "term-data-home");
    process.env["COUNCIL_DATA_HOME"] = customDataHome;
    const originalTerm = process.env["TERM"];
    process.env["TERM"] = "xterm\tTAB\u2028LS\u2029PS\r\nCRLF\u001b[31mANSI";

    try {
      const output = await runDoctor(["--offline"]);
      const termLine =
        output.split("\n").find((line) => line.trimStart().startsWith("TERM:")) ?? "";

      // tab, U+2028, U+2029, CR/LF and ANSI must all collapse/strip to one line.
      expect(termLine).toBe("   TERM: xterm TAB LS PS CRLFANSI");
      expect(termLine).not.toContain("\t");
      expect(termLine).not.toContain("\u2028");
      expect(termLine).not.toContain("\u2029");
      expect(termLine).not.toContain("\u001b");
    } finally {
      if (originalTerm === undefined) delete process.env["TERM"];
      else process.env["TERM"] = originalTerm;
    }
  });

  it("doctor sanitizes adversarial control bytes in Terminal env values to a single control-free line (#1483)", async () => {
    const customDataHome = path.join(testHome, "adversarial-term-data-home");
    process.env["COUNCIL_DATA_HOME"] = customDataHome;
    const original = process.env["COLORTERM"];
    // One marker letter after each adversarial byte class so the surviving
    // output is easy to assert exactly: TAB, C0 (SOH/BEL), ANSI CSI, C1 (CSI),
    // DEL, bidi override + isolate, CR/LF, and U+2028/U+2029 separators.
    process.env["COLORTERM"] =
      "A\tB" + // TAB (U+0009)
      "\u0001C" + // C0 control (SOH)
      "\u0007D" + // C0 control (BEL)
      "\u001b[31mE" + // ANSI CSI escape
      "\u009bF" + // C1 control (CSI)
      "\u007fG" + // DEL
      "\u202eH" + // bidi override
      "\u2066I" + // bidi isolate
      "\r\nJ" + // CR/LF
      "\u2028K" + // line separator
      "\u2029L"; // paragraph separator

    try {
      const output = await runDoctor(["--offline"]);
      const colorLine =
        output.split("\n").find((line) => line.trimStart().startsWith("COLORTERM:")) ?? "";

      // Every adversarial byte is stripped or collapsed to a space, leaving a
      // single control-free line whose printable markers survive in order.
      expect(colorLine).toBe("   COLORTERM: A BCDEFGHI J K L");
      for (const forbidden of [
        "\t",
        "\r",
        "\n",
        "\u2028",
        "\u2029",
        "\u0001",
        "\u0007",
        "\u001b",
        "\u009b",
        "\u007f",
        "\u202e",
        "\u2066",
      ]) {
        expect(colorLine).not.toContain(forbidden);
      }
    } finally {
      if (original === undefined) delete process.env["COLORTERM"];
      else process.env["COLORTERM"] = original;
    }
  });

  it("doctor --models lists live discovered models", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "OK" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.6", "gpt-5.4", "gemini-2.5-pro"],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { onlineProbe, discoverModels });

    expect(output).toContain("Available models:");
    expect(output).toContain("Anthropic: claude-sonnet-4.6");
    expect(output).toContain("OpenAI   : gpt-5.4");
    expect(output).toContain("Google   : gemini-2.5-pro");
    expect(output).toContain("Availability depends on your Copilot tier");
    expect(onlineProbe).not.toHaveBeenCalled();
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models labels static fallback when live discovery is unavailable", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["claude-haiku-4.5", "claude-sonnet-4.5", "gpt-5.4", "gpt-5.4-mini"],
      source: "static" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Known models (live discovery unavailable):");
    expect(output).toContain("Anthropic: claude-haiku-4.5, claude-sonnet-4.5");
    expect(output).toContain("OpenAI   : gpt-5.4, gpt-5.4-mini");
    expect(output).not.toContain("Google");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models preserves discovered order within provider groups", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["gpt-5.4-mini", "claude-sonnet-4.5", "gpt-5.4", "claude-haiku-4.5"],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Available models:");
    expect(output).toContain("Anthropic: claude-sonnet-4.5, claude-haiku-4.5");
    expect(output).toContain("OpenAI   : gpt-5.4-mini, gpt-5.4");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models filters invalid discovered model IDs and deduplicates sanitized matches", async () => {
    const discoverModels = vi.fn(async () => ({
      models: [
        "claude-\u001b[31msonnet-4.6\u001b[0m",
        "gpt-5.4",
        "gpt-\u001b[31m5.4\u001b[0m",
        "gpt-5.4\nmini",
        "gpt-5.4;rm -rf /",
      ],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Anthropic: claude-sonnet-4.6");
    expect(output).toContain("OpenAI   : gpt-5.4");
    expect(output).not.toContain("gpt-5.4, gpt-5.4");
    expect(output).not.toContain("gpt-5.4 mini");
    expect(output).not.toContain("gpt-5.4;rm -rf /");
    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("gpt-5.4\nmini");
  });

  it("doctor excludes shell metacharacters and option-like IDs from remediation alternatives", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: [
        "claude-sonnet-4.5",
        "gpt-5.4",
        "gpt-\u001b[31m5.4\u001b[0m",
        "--help",
        "-x",
        "gpt-5.4;rm -rf /",
      ],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });
    const alternativesBlock =
      output.match(/Available alternatives:\n([\s\S]*?)\n\s*Fix:/)?.[1] ?? "";

    expect(output).toContain("Available alternatives:");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4");
    expect(alternativesBlock).toContain("     gpt-5.4");
    expect(alternativesBlock).not.toContain("gpt-5.4, gpt-5.4");
    expect(alternativesBlock).not.toContain("--help");
    expect(alternativesBlock).not.toContain("-x");
    expect(alternativesBlock).not.toContain("gpt-5.4;rm -rf /");
    expect(output).not.toContain("\u001b[31m");
  });

  it("doctor excludes discovered models that sanitize to the active model", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-\u001b[31msonnet-4.5\u001b[0m", "gpt-5.4-mini"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(output).toContain("Available alternatives:");
    expect(output).toContain("     gpt-5.4-mini");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4-mini");
    expect(output).not.toContain("claude-sonnet-4.5, gpt-5.4-mini");
  });

  it("doctor omits remediation guidance when no valid alternatives remain", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-\u001b[31msonnet-4.5\u001b[0m", "gpt-5.4\nmini", "gpt-5.4;rm -rf /"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(output).toContain(
      "Default model (claude-sonnet-4.5) is not accessible: model not found",
    );
    expect(output).not.toContain("Available alternatives:");
    expect(output).not.toContain("Fix: council config set defaults.model");
  });

  it("doctor help describes the offline and models flags", () => {
    const help = buildDoctorCommandWithDeps({}).helpInformation();

    expect(help).toContain("Skip online model probe");
    expect(help).toMatch(/List available Copilot models \(live discovery with static\s+fallback\)/);
  });

  it("doctor shows Configuration section with defaults", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "ok" }));
    const output = await runDoctor([], { onlineProbe });

    expect(output).toContain("Config");
    expect(output).toContain("Path:");
    expect(output).toContain("config.yaml");
    expect(output).toContain("Engine: copilot");
    expect(output).toContain("Rounds: 4");
  });

  it("doctor shows Configuration with custom config values", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      "defaults:\n  engine: mock\n  maxRounds: 7\n",
      "utf-8",
    );

    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "ok" }));
    const output = await runDoctor([], { onlineProbe });

    expect(output).toContain("Engine: mock");
    expect(output).toContain("Rounds: 7");
  });

  it("doctor shows warning when config is invalid", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(path.join(testHome, "config.yaml"), "{{invalid yaml", "utf-8");

    const output = await runDoctor([]);

    expect(output).toContain("Could not load configuration");
  });

  it("doctor drives the injected spinner around each check", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const createSpinner = vi.fn(() => ({ start, stop }));
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "ok" }));

    await runDoctor([], { onlineProbe, createSpinner });

    expect(createSpinner).toHaveBeenCalledTimes(1);
    // 7 base checks + 1 default-model-access check (online runs by default).
    expect(start).toHaveBeenCalledTimes(8);
    expect(stop).toHaveBeenCalledTimes(8);
    expect(start).toHaveBeenCalledWith("Node.js version");
    expect(start).toHaveBeenCalledWith("Copilot CLI");
    expect(start).toHaveBeenCalledWith("Default model access");
  });

  it("doctor report content is byte-identical whether or not a spinner is injected", async () => {
    const probe = (): Promise<{ ok: boolean; detail: string }> =>
      Promise.resolve({ ok: true, detail: "ok" });

    const noSpinner = await runDoctor(["--offline"], { onlineProbe: vi.fn(probe) });
    const withSpinner = await runDoctor(["--offline"], {
      onlineProbe: vi.fn(probe),
      createSpinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    });

    expect(withSpinner).toBe(noSpinner);
  });

  it("doctor passes the Copilot CLI check when the entry resolves", async () => {
    const cliEntry = path.join(testHome, "npm-loader.js");
    await fs.writeFile(cliEntry, "// loader", "utf-8");

    const output = await runDoctor(["--offline"], { resolveCliPath: () => cliEntry });

    expect(output).toContain("Copilot CLI");
    expect(output).not.toContain("known Windows path-resolution issue");
  });

  it("doctor prints actionable remediation when the Copilot CLI path cannot be resolved", async () => {
    const output = await runDoctor(["--offline"], { resolveCliPath: () => undefined });

    expect(output).toContain("Copilot CLI");
    expect(output).toContain("COPILOT_CLI_PATH");
    expect(output).toContain("@github/copilot/npm-loader.js");
  });

  it("doctor flags the bogus @github/index.js CLI path", async () => {
    const output = await runDoctor(["--offline"], {
      resolveCliPath: () => "/proj/node_modules/@github/index.js",
    });

    expect(output).toContain("COPILOT_CLI_PATH");
    expect(output).toContain("@github/copilot/npm-loader.js");
  });

  it("doctor respects an existing COPILOT_CLI_PATH override", async () => {
    process.env["COPILOT_CLI_PATH"] = "/custom/copilot/entry.js";

    const output = await runDoctor(["--offline"], { resolveCliPath: () => undefined });

    expect(output).toContain("COPILOT_CLI_PATH override");
    expect(output).not.toContain("known Windows path-resolution issue");
  });

  it("doctor Copilot CLI remediation does not leak the home path or username", async () => {
    const output = await runDoctor(["--offline"], { resolveCliPath: () => undefined });
    const remediationLine =
      output.split("\n").find((line) => line.includes("COPILOT_CLI_PATH")) ?? "";

    expect(remediationLine).toContain("npm-loader.js");
    expect(remediationLine).not.toContain(os.homedir());
    expect(remediationLine).not.toContain(os.userInfo().username);
  });

  it("doctor lists each known provider with availability sourced from the registry", async () => {
    const output = await runDoctor(["--offline"]);

    expect(output).toContain("Providers");

    const lineFor = (id: string): string =>
      output.split("\n").find((line) => line.trimStart().startsWith(`${id} `)) ?? "";

    const copilotLine = lineFor("copilot");
    expect(copilotLine).toContain("available");
    expect(copilotLine).not.toContain("not yet");

    const mockLine = lineFor("mock");
    expect(mockLine).toContain("available");
    expect(mockLine).not.toContain("not yet");

    const openaiLine = lineFor("openai");
    expect(openaiLine).toContain("not yet available");
    expect(openaiLine).toContain("coming soon");

    const anthropicLine = lineFor("anthropic");
    expect(anthropicLine).toContain("not yet available");
    expect(anthropicLine).toContain("coming soon");
  });

  it("doctor provider section never prints an API key value", async () => {
    const original = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-LEAKED-SECRET-doctor-value";
    try {
      const output = await runDoctor(["--offline"]);

      expect(output).toContain("Providers");
      expect(output).not.toContain("sk-LEAKED-SECRET-doctor-value");
    } finally {
      if (original === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = original;
    }
  });

  it("doctor provider section respects ASCII mode (NO_COLOR)", async () => {
    const original = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      const output = await runDoctor(["--offline"]);

      expect(output).toContain("[i] Providers");

      const providerLines = output
        .split("\n")
        .filter((line) => /^\s+(copilot|mock|openai|anthropic) /.test(line));
      expect(providerLines.length).toBeGreaterThanOrEqual(4);
      for (const line of providerLines) {
        expect(line).not.toContain("\u2014");
      }
    } finally {
      if (original === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = original;
    }
  });
});

describe("checkNodeVersion", () => {
  it("fails for Node older than 24", async () => {
    const result = await checkNodeVersion("23.5.0");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("24 or newer");
  });

  it("passes for Node 24 and newer", async () => {
    const result = await checkNodeVersion("24.0.0");
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(">= 24 required");
  });
});

/**
 * Tests for `council doctor --report json|markdown`.
 *
 * The report is a SANITIZED bug-report payload. The privacy policy
 * (PRIVACY.md / docs/TELEMETRY.md) forbids disclosing prompts/content, full
 * file paths, usernames, environment values, tokens/API keys, SQLite
 * contents, and the full configuration object. These tests assert — across
 * BOTH json and markdown — that none of those leak, while the safe
 * diagnostics (version, OS family/arch, Node version, terminal capability
 * booleans, per-check status, Copilot CLI path STATUS category, and the
 * telemetry-enabled boolean) are present.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDoctorCommand } from "../../../../src/cli/commands/doctor.js";
import {
  buildDoctorReport,
  collectTerminalCapabilities,
  isDoctorReportFormat,
  renderDoctorReport,
  type DoctorReport,
  type DoctorReportCheck,
} from "../../../../src/cli/commands/doctor-report.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface SpinnerLike {
  start(label: string): void;
  stop(): void;
}

interface DoctorDepsLike {
  readonly write?: Writer;
  readonly version?: string;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
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

/** A path-shaped sentinel that must never survive into a sanitized report. */
const CLI_PATH_SENTINEL = "/Users/SENTINEL_USERNAME/sdk/@github/copilot/index.js";
const ENV_SECRET_SENTINEL = "tok_SENTINELSECRET_must_not_leak";

/** Config-only keys that would only appear if the full config were dumped. */
const CONFIG_ONLY_KEYS = ["supportedFormats", "maxWordsPerResponse", "recencyHalfLifeDays"];

function assertNoSensitiveLeak(output: string): void {
  expect(output).not.toContain(CLI_PATH_SENTINEL);
  expect(output).not.toContain("SENTINEL_USERNAME");
  expect(output).not.toContain(ENV_SECRET_SENTINEL);
  // Real machine identifiers that the underlying checks legitimately know
  // about (e.g. the Council data home defaults to a path under the home
  // directory) must never reach the report.
  expect(output).not.toContain(os.homedir());
  expect(output).not.toContain(os.userInfo().username);
  for (const key of CONFIG_ONLY_KEYS) {
    expect(output).not.toContain(key);
  }
}

describe("doctor --report (integration)", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalCliPath: string | undefined;
  let originalSecret: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-report-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    originalCliPath = process.env["COPILOT_CLI_PATH"];
    originalSecret = process.env["SUPER_SECRET_TOKEN"];
    process.env["COUNCIL_HOME"] = testHome;
    // Leave COUNCIL_DATA_HOME unset so the data-home check resolves under the
    // real home directory — a sentinel for path leakage.
    delete process.env["COUNCIL_DATA_HOME"];
    delete process.env["COPILOT_CLI_PATH"];
    process.env["SUPER_SECRET_TOKEN"] = ENV_SECRET_SENTINEL;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    if (originalCliPath === undefined) delete process.env["COPILOT_CLI_PATH"];
    else process.env["COPILOT_CLI_PATH"] = originalCliPath;
    if (originalSecret === undefined) delete process.env["SUPER_SECRET_TOKEN"];
    else process.env["SUPER_SECRET_TOKEN"] = originalSecret;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("--report json emits parseable, sanitized JSON", async () => {
    const output = await runDoctor(["--report", "json", "--offline"], {
      version: "9.9.9",
      resolveCliPath: () => CLI_PATH_SENTINEL,
    });

    const parsed = JSON.parse(output) as DoctorReport;
    expect(parsed.cliVersion).toBe("9.9.9");
    expect(parsed.os.family).toBe(os.platform());
    expect(parsed.os.arch).toBe(os.arch());
    expect(parsed.node).toBe(process.versions.node);
    expect(typeof parsed.terminal.noColor).toBe("boolean");
    expect(typeof parsed.terminal.tty).toBe("boolean");
    expect(typeof parsed.terminal.ascii).toBe("boolean");
    expect(parsed.telemetryEnabled).toBe(false);
    // Status CATEGORY, never the resolved path.
    expect(parsed.copilotCliPathStatus).toBe("needs-remediation");
    const checkNames = parsed.checks.map((c) => c.name);
    expect(checkNames).toContain("Node.js version");
    expect(checkNames).toContain("Copilot CLI");
    for (const check of parsed.checks) {
      expect(["pass", "warn", "fail"]).toContain(check.status);
    }

    assertNoSensitiveLeak(output);
  });

  it("--report json never includes a check detail field", async () => {
    const output = await runDoctor(["--report", "json", "--offline"], {
      resolveCliPath: () => CLI_PATH_SENTINEL,
    });

    const parsed = JSON.parse(output) as { checks: readonly Record<string, unknown>[] };
    for (const check of parsed.checks) {
      expect(check).not.toHaveProperty("detail");
      expect(Object.keys(check).sort()).toEqual(["name", "status"]);
    }
  });

  it("--report markdown emits a paste-ready, sanitized section", async () => {
    const output = await runDoctor(["--report", "markdown", "--offline"], {
      version: "9.9.9",
      resolveCliPath: () => CLI_PATH_SENTINEL,
    });

    expect(output).toMatch(/^#{2,3}\s/m);
    expect(output).toContain("| Check | Status |");
    expect(output).toContain("9.9.9");
    expect(output).toContain(os.platform());
    expect(output).toContain(os.arch());
    expect(output).toContain("needs-remediation");
    expect(output).toContain("Node.js version");

    assertNoSensitiveLeak(output);
  });

  it("--report markdown reports the Copilot CLI override category without the path", async () => {
    process.env["COPILOT_CLI_PATH"] = CLI_PATH_SENTINEL;

    const output = await runDoctor(["--report", "markdown", "--offline"], {
      resolveCliPath: () => CLI_PATH_SENTINEL,
    });

    expect(output).toContain("override");
    assertNoSensitiveLeak(output);
  });

  it("rejects an unknown --report format without emitting a report", async () => {
    const output = await runDoctor(["--report", "xml", "--offline"]);

    expect(output).not.toContain("cliVersion");
    expect(() => JSON.parse(output)).toThrow();
  });

  it("--report json includes coarse provider availability from the registry", async () => {
    const output = await runDoctor(["--report", "json", "--offline"], {
      resolveCliPath: () => CLI_PATH_SENTINEL,
    });

    const parsed = JSON.parse(output) as {
      providers: readonly { id: string; available: boolean }[];
    };
    const availability = new Map(parsed.providers.map((p) => [p.id, p.available]));
    expect(availability.get("copilot")).toBe(true);
    expect(availability.get("mock")).toBe(true);
    expect(availability.get("openai")).toBe(false);
    expect(availability.get("anthropic")).toBe(false);

    assertNoSensitiveLeak(output);
  });

  it("--report json provider entries expose only id + available (no env var name or value)", async () => {
    const original = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-REPORT-SECRET-value";
    try {
      const output = await runDoctor(["--report", "json", "--offline"]);

      const parsed = JSON.parse(output) as {
        providers: readonly Record<string, unknown>[];
      };
      expect(parsed.providers.length).toBeGreaterThan(0);
      for (const provider of parsed.providers) {
        expect(Object.keys(provider).sort()).toEqual(["available", "id"]);
      }
      expect(output).not.toContain("sk-REPORT-SECRET-value");
      expect(output).not.toContain("OPENAI_API_KEY");
    } finally {
      if (original === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = original;
    }
  });

  it("--report markdown lists provider availability and stays sanitized", async () => {
    const output = await runDoctor(["--report", "markdown", "--offline"], {
      resolveCliPath: () => CLI_PATH_SENTINEL,
    });

    expect(output).toContain("| Provider | Available |");
    expect(output).toContain("| copilot | true |");
    expect(output).toContain("| openai | false |");

    assertNoSensitiveLeak(output);
  });
});

describe("buildDoctorReport (unit)", () => {
  const baseChecks: readonly DoctorReportCheck[] = [
    { name: "Node.js version", status: "pass" },
    { name: "Copilot CLI", status: "fail" },
  ];

  it("includes only whitelisted safe fields", () => {
    const report = buildDoctorReport({
      cliVersion: "1.2.3",
      checks: baseChecks,
      copilotCliPathStatus: "ok",
      telemetryEnabled: true,
      platform: "linux",
      arch: "x64",
      nodeVersion: "24.0.0",
      terminal: { noColor: true, tty: false, ascii: true },
      providers: [{ id: "copilot", available: true }],
    });

    expect(report).toEqual({
      cliVersion: "1.2.3",
      os: { family: "linux", arch: "x64" },
      node: "24.0.0",
      terminal: { noColor: true, tty: false, ascii: true },
      copilotCliPathStatus: "ok",
      telemetryEnabled: true,
      providers: [{ id: "copilot", available: true }],
      checks: [
        { name: "Node.js version", status: "pass" },
        { name: "Copilot CLI", status: "fail" },
      ],
    });
  });

  it("includes coarse provider availability and sanitizes provider ids", () => {
    const report = buildDoctorReport({
      cliVersion: "1.0.0",
      checks: baseChecks,
      copilotCliPathStatus: "ok",
      telemetryEnabled: false,
      providers: [
        { id: "copilot", available: true },
        { id: "openai\u001b[31m", available: false },
      ],
    });

    expect(report.providers).toEqual([
      { id: "copilot", available: true },
      { id: "openai", available: false },
    ]);
  });

  it("drops any non-whitelisted property smuggled into a check", () => {
    const poisoned = [
      { name: "Disk write", status: "pass", detail: `/Users/secret/${os.userInfo().username}` },
    ] as unknown as readonly DoctorReportCheck[];

    const report = buildDoctorReport({
      cliVersion: "1.0.0",
      checks: poisoned,
      copilotCliPathStatus: "needs-remediation",
      telemetryEnabled: false,
    });

    const rendered = renderDoctorReport(report, "json");
    expect(rendered).not.toContain("/Users/secret/");
    expect(rendered).not.toContain("detail");
  });

  it("strips control characters from string fields", () => {
    const report = buildDoctorReport({
      cliVersion: "1.0.0\u001b[31m",
      checks: [{ name: "Evil\u0007Check", status: "warn" }],
      copilotCliPathStatus: "ok",
      telemetryEnabled: false,
    });

    expect(report.cliVersion).toBe("1.0.0");
    expect(report.checks[0]?.name).toBe("EvilCheck");
  });
});

describe("renderDoctorReport (unit)", () => {
  const report: DoctorReport = {
    cliVersion: "0.1.0",
    os: { family: "darwin", arch: "arm64" },
    node: "24.1.0",
    terminal: { noColor: false, tty: true, ascii: false },
    copilotCliPathStatus: "ok",
    telemetryEnabled: false,
    providers: [{ id: "copilot", available: true }],
    checks: [{ name: "Node.js version", status: "pass" }],
  };

  it("json output round-trips through JSON.parse", () => {
    const out = renderDoctorReport(report, "json");
    expect(JSON.parse(out)).toEqual(report);
  });

  it("markdown output contains a header and a checks table", () => {
    const out = renderDoctorReport(report, "markdown");
    expect(out).toMatch(/^#{2,3}\s/m);
    expect(out).toContain("| Check | Status |");
    expect(out).toContain("Node.js version");
    expect(out).toContain("pass");
  });

  it("markdown output contains a providers table", () => {
    const out = renderDoctorReport(report, "markdown");
    expect(out).toContain("| Provider | Available |");
    expect(out).toContain("| copilot | true |");
  });
});

describe("collectTerminalCapabilities (unit)", () => {
  it("derives ASCII mode from NO_COLOR / COUNCIL_ASCII / TERM=dumb", () => {
    expect(collectTerminalCapabilities({ NO_COLOR: "1" }, false)).toEqual({
      noColor: true,
      tty: false,
      ascii: true,
    });
    expect(collectTerminalCapabilities({ COUNCIL_ASCII: "1" }, true)).toEqual({
      noColor: false,
      tty: true,
      ascii: true,
    });
    expect(collectTerminalCapabilities({ TERM: "dumb" }, false)).toEqual({
      noColor: false,
      tty: false,
      ascii: true,
    });
    expect(collectTerminalCapabilities({}, true)).toEqual({
      noColor: false,
      tty: true,
      ascii: false,
    });
  });
});

describe("isDoctorReportFormat (unit)", () => {
  it("accepts only json and markdown", () => {
    expect(isDoctorReportFormat("json")).toBe(true);
    expect(isDoctorReportFormat("markdown")).toBe(true);
    expect(isDoctorReportFormat("xml")).toBe(false);
    expect(isDoctorReportFormat("")).toBe(false);
    expect(isDoctorReportFormat(undefined)).toBe(false);
  });
});

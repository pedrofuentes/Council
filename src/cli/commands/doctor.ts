/**
 * `council doctor` — diagnose the local Council setup.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome, loadConfig } from "../../config/index.js";
import { pingProviderHealth } from "../../engine/copilot/health.js";
import { KNOWN_MODELS } from "../../engine/models.js";

import { probeCopilotModel } from "./doctor-online-probe.js";
import { defaultWriter, type Writer } from "./writer.js";

const CONFIG_FILE = "config.yaml";
const MODEL_GROUPS = [
  { label: "Anthropic", prefix: "claude-" },
  { label: "OpenAI", prefix: "gpt-" },
  { label: "Google", prefix: "gemini-" },
] as const;

interface CheckResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly detail: string;
}

interface DoctorOptions {
  readonly online?: boolean;
  readonly models?: boolean;
}

export interface DoctorDeps {
  readonly write?: Writer;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    return {
      name: "Node.js version",
      status: "pass",
      detail: `v${process.versions.node} (>= 20 required)`,
    };
  }
  return {
    name: "Node.js version",
    status: "fail",
    detail: `v${process.versions.node} is too old; Council requires Node.js 20 or newer`,
  };
}

async function checkCouncilHome(): Promise<CheckResult> {
  const home = getCouncilHome();
  try {
    await fs.mkdir(home, { recursive: true });
    return { name: "Council home", status: "pass", detail: home };
  } catch (err: unknown) {
    return {
      name: "Council home",
      status: "fail",
      detail: `cannot create ${home}: ${formatError(err)}`,
    };
  }
}

async function checkSqlite(): Promise<CheckResult> {
  try {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: ":memory:" });
    await client.execute("SELECT 1");
    client.close();
    return { name: "SQLite (libsql)", status: "pass", detail: "in-memory DB OK" };
  } catch (err: unknown) {
    return {
      name: "SQLite (libsql)",
      status: "fail",
      detail: formatError(err),
    };
  }
}

async function checkCopilotSdk(): Promise<CheckResult> {
  const health = pingProviderHealth();
  return {
    name: "Copilot SDK",
    status: health.ok ? "pass" : "fail",
    detail: health.detail,
  };
}

async function checkDiskSpace(): Promise<CheckResult> {
  const home = getCouncilHome();
  const testFile = path.join(home, ".doctor-write-test");
  try {
    await fs.writeFile(testFile, "ok", "utf-8");
    await fs.unlink(testFile);
    return { name: "Disk write", status: "pass", detail: `${home} is writable` };
  } catch (err: unknown) {
    return {
      name: "Disk write",
      status: "fail",
      detail: `cannot write under ${home}: ${formatError(err)}`,
    };
  }
}

async function checkDefaultModelAccess(
  onlineProbe: NonNullable<DoctorDeps["onlineProbe"]>,
): Promise<CheckResult> {
  const configPath = getConfigPath();

  let model: string;
  try {
    const config = await loadConfig();
    model = config.defaults.model;
  } catch (err: unknown) {
    return {
      name: "Default model access",
      status: "fail",
      detail: `could not load config for online probe: ${formatError(err)}. Try changing defaults.model in ${configPath}`,
    };
  }

  try {
    const probe = await onlineProbe(model);
    if (probe.ok) {
      return {
        name: "Default model access",
        status: "pass",
        detail: `Default model (${model}) is accessible`,
      };
    }
    return {
      name: "Default model access",
      status: "fail",
      detail: `Default model (${model}) is not accessible: ${probe.detail}. Try changing defaults.model in ${configPath}`,
    };
  } catch (err: unknown) {
    return {
      name: "Default model access",
      status: "fail",
      detail: `Default model (${model}) probe failed: ${formatError(err)}. Try changing defaults.model in ${configPath}`,
    };
  }
}

function getConfigPath(): string {
  return path.join(getCouncilHome(), CONFIG_FILE);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusIcon(status: CheckResult["status"]): string {
  switch (status) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "warn":
      return "⚠️";
  }
}

function writeKnownModels(write: Writer, models: readonly string[]): void {
  write("Known models:\n");
  const labelWidth = Math.max(...MODEL_GROUPS.map((group) => group.label.length));
  for (const group of MODEL_GROUPS) {
    const groupedModels = models.filter((model) => model.startsWith(group.prefix));
    if (groupedModels.length === 0) {
      continue;
    }
    write(`  ${group.label.padEnd(labelWidth, " ")}: ${groupedModels.join(", ")}\n`);
  }
  write("\n");
  write("Note: Availability depends on your Copilot tier. Use --online to check.\n");
}

function isWriter(input: DoctorDeps | Writer): input is Writer {
  return typeof input === "function";
}

function resolveDoctorDeps(input: DoctorDeps | Writer): Required<DoctorDeps> {
  const deps = isWriter(input) ? { write: input } : input;
  return {
    write: deps.write ?? defaultWriter,
    onlineProbe: deps.onlineProbe ?? probeCopilotModel,
  };
}

export function buildDoctorCommand(input: DoctorDeps | Writer = {}): Command {
  const { write, onlineProbe } = resolveDoctorDeps(input);
  const cmd = new Command("doctor");
  cmd
    .description("Diagnose Council setup (Node, libsql, Copilot SDK, disk)")
    .option("--online", "Probe Copilot for model availability (requires auth)")
    .option("--models", "List known Copilot model identifiers")
    .action(async (options: DoctorOptions) => {
      const checks: (() => Promise<CheckResult>)[] = [
        checkNodeVersion,
        checkCouncilHome,
        checkSqlite,
        checkCopilotSdk,
        checkDiskSpace,
      ];

      if (options.online) {
        checks.push(() => checkDefaultModelAccess(onlineProbe));
      }

      write("Council Doctor\n");
      write("═".repeat(40) + "\n");
      write(`Platform: ${os.platform()} ${os.arch()}\n`);
      write("\n");

      let allPassed = true;
      for (const run of checks) {
        const result = await run();
        if (result.status === "fail") {
          allPassed = false;
        }
        write(`${statusIcon(result.status)} ${result.name}\n   ${result.detail}\n`);
      }

      if (options.models) {
        write("\n");
        writeKnownModels(write, KNOWN_MODELS);
      }

      write("\n");
      if (allPassed) {
        write("All checks passed. Council is ready to convene.\n");
        return;
      }

      write("Some checks failed. See output above for remediation.\n");
      cmd.error("doctor checks failed", { exitCode: 1, code: "council.doctor.failed" });
    });
  return cmd;
}

/**
 * `council doctor` — diagnose the local Council setup.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome, loadConfig } from "../../config/index.js";
import {
  discoverAvailableModels,
  pingProviderHealth,
  type ModelDiscoveryResult,
} from "../../engine/copilot/health.js";
import { KNOWN_MODELS } from "../../engine/models.js";
import { getSymbols } from "../renderers/symbols.js";
import { stripControlChars } from "../strip-control-chars.js";

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
  readonly offline?: boolean;
  readonly models?: boolean;
}

export interface DoctorDeps {
  readonly write?: Writer;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
  readonly discoverModels?: () => Promise<ModelDiscoveryResult>;
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
  discoverModels: NonNullable<DoctorDeps["discoverModels"]>,
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
        detail: `Default model (${model}) session created successfully`,
      };
    }
    return {
      name: "Default model access",
      status: "fail",
      detail: await buildModelAccessFailureDetail(
        `Default model (${model}) is not accessible: ${probe.detail}`,
        model,
        discoverModels,
      ),
    };
  } catch (err: unknown) {
    return {
      name: "Default model access",
      status: "fail",
      detail: await buildModelAccessFailureDetail(
        `Default model (${model}) probe failed: ${formatError(err)}`,
        model,
        discoverModels,
      ),
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
  const sym = getSymbols();
  switch (status) {
    case "pass":
      return `${sym.pass} PASS`;
    case "fail":
      return `${sym.fail} FAIL`;
    case "warn":
      return `${sym.warn} WARN`;
  }
}

function sanitizeModelId(id: string): string {
  return stripControlChars(id).replace(/[\r\n]+/g, " ").trim();
}

async function buildModelAccessFailureDetail(
  failureDetail: string,
  model: string,
  discoverModels: NonNullable<DoctorDeps["discoverModels"]>,
): Promise<string> {
  try {
    const discovery = await discoverModels();
    const alternatives = discovery.models
      .filter((candidate) => candidate !== model)
      .map(sanitizeModelId)
      .filter((candidate) => candidate.length > 0);
    if (alternatives.length === 0) {
      return failureDetail;
    }
    return (
      `${failureDetail}\n` +
      "   \n" +
      "   Available alternatives:\n" +
      `     ${alternatives.join(", ")}\n` +
      "   \n" +
      `   Fix: council config set defaults.model ${alternatives[0]}`
    );
  } catch {
    return failureDetail;
  }
}

function sortModelsForDisplay(models: readonly string[]): readonly string[] {
  const knownModelOrder = new Map(KNOWN_MODELS.map((model, index) => [model, index]));
  return [...models].sort((left, right) => {
    const leftOrder = knownModelOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = knownModelOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.localeCompare(right);
  });
}

function writeKnownModels(write: Writer, label: string, models: readonly string[]): void {
  write(`${label}\n`);
  const orderedModels = sortModelsForDisplay(
    models.map(sanitizeModelId).filter((model) => model.length > 0),
  );
  const labelWidth = Math.max(...MODEL_GROUPS.map((group) => group.label.length));
  for (const group of MODEL_GROUPS) {
    const groupedModels = orderedModels.filter((model) => model.startsWith(group.prefix));
    if (groupedModels.length === 0) {
      continue;
    }
    write(`  ${group.label.padEnd(labelWidth, " ")}: ${groupedModels.join(", ")}\n`);
  }
  write("\n");
  write(
    "Note: Known models: Availability depends on your Copilot tier. Use 'council doctor' to verify your default model is accessible.\n",
  );
}

function isWriter(input: DoctorDeps | Writer): input is Writer {
  return typeof input === "function";
}

function resolveDoctorDeps(input: DoctorDeps | Writer): Required<DoctorDeps> {
  const deps = isWriter(input) ? { write: input } : input;
  return {
    write: deps.write ?? defaultWriter,
    onlineProbe: deps.onlineProbe ?? probeCopilotModel,
    discoverModels: deps.discoverModels ?? discoverAvailableModels,
  };
}

export function buildDoctorCommand(input: DoctorDeps | Writer = {}): Command {
  const { write, onlineProbe, discoverModels } = resolveDoctorDeps(input);
  const cmd = new Command("doctor");
  cmd
    .description("Diagnose Council setup (Node, libsql, Copilot SDK, disk)")
    .option("--online", "No-op; online check now runs by default (backwards compatibility)")
    .option("--offline", "Skip online model probe")
    .option("--models", "List known Copilot model identifiers")
    .action(async (options: DoctorOptions) => {
      const checks: (() => Promise<CheckResult>)[] = [
        checkNodeVersion,
        checkCouncilHome,
        checkSqlite,
        checkCopilotSdk,
        checkDiskSpace,
      ];

      // Run online check by default unless --offline is specified
      if (!options.offline) {
        checks.push(() => checkDefaultModelAccess(onlineProbe, discoverModels));
      }

      write("Council Doctor\n");
      const sym = getSymbols();
      write(sym.headerRule.repeat(40) + "\n");
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

      // Configuration section (DX-09)
      write("\n");
      try {
        const config = await loadConfig();
        const configFilePath = path.join(getCouncilHome(), CONFIG_FILE);
        const sym2 = getSymbols();
        write(
          `${sym2.pass} Config\n` +
            `   Path: ${configFilePath}\n` +
            `   Engine: ${config.defaults.engine} | Model: ${config.defaults.model} | Rounds: ${config.defaults.maxRounds}\n`,
        );
      } catch {
        const sym2 = getSymbols();
        write(`${sym2.warn} Config\n   Could not load configuration\n`);
      }

      // Terminal capability section (A11Y-16)
      write("\n");
      const safeEnv = (key: string): string =>
        stripControlChars(process.env[key] ?? "(unset)").replace(/[\r\n]+/g, " ");
      write(`${sym.info} Terminal\n`);
      write(`   TERM: ${safeEnv("TERM")}\n`);
      write(`   COLORTERM: ${safeEnv("COLORTERM")}\n`);
      write(`   NO_COLOR: ${safeEnv("NO_COLOR")}\n`);
      write(`   FORCE_COLOR: ${safeEnv("FORCE_COLOR")}\n`);
      write(`   TTY: ${process.stdout.isTTY ? "yes" : "no"}\n`);
      write(`   Columns: ${process.stdout.columns ?? "(unknown)"}\n`);

      if (options.models) {
        const modelDiscovery = await discoverModels();
        write("\n");
        writeKnownModels(
          write,
          modelDiscovery.source === "live"
            ? "Available models:"
            : "Known models (live discovery unavailable):",
          modelDiscovery.models,
        );
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

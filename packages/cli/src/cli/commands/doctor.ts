/**
 * `council doctor` — diagnose the local Council setup.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";

import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
} from "../../config/index.js";
import {
  checkCopilotCliPath,
  discoverAvailableModels,
  pingProviderHealth,
  resolveCopilotCliPath,
  type ModelDiscoveryResult,
} from "../../engine/copilot/health.js";
import {
  PROVIDER_IDS,
  getProviderApiKeyEnvVar,
  isProviderAvailable,
  type ProviderId,
} from "../../engine/providers.js";
import { getSymbols } from "../renderers/symbols.js";
import { renderBanner } from "../renderers/banner.js";
import { createSpinner, type Spinner } from "../renderers/spinner.js";
import { stripControlChars } from "../strip-control-chars.js";

import packageJson from "../../../package.json" with { type: "json" };

import { probeCopilotModel } from "./doctor-online-probe.js";
import {
  buildDoctorReport,
  collectTerminalCapabilities,
  isDoctorReportFormat,
  renderDoctorReport,
  type DoctorProviderAvailability,
  type DoctorReportCheck,
} from "./doctor-report.js";
import { formatAvailableModels } from "./models.js";
import { defaultWriter, type Writer } from "./writer.js";

const CONFIG_FILE = "config.yaml";

interface CheckResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly detail: string;
}

interface DoctorOptions {
  readonly online?: boolean;
  readonly offline?: boolean;
  readonly models?: boolean;
  readonly report?: string;
}

export interface DoctorDeps {
  readonly write?: Writer;
  readonly version?: string;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
  readonly discoverModels?: () => Promise<ModelDiscoveryResult>;
  readonly createSpinner?: () => Spinner;
  readonly resolveCliPath?: () => string | undefined;
}

interface LabeledCheck {
  readonly label: string;
  readonly run: () => Promise<CheckResult>;
}

export async function checkNodeVersion(
  nodeVersion: string = process.versions.node,
): Promise<CheckResult> {
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (major >= 24) {
    return {
      name: "Node.js version",
      status: "pass",
      detail: `v${nodeVersion} (>= 24 required)`,
    };
  }
  return {
    name: "Node.js version",
    status: "fail",
    detail: `v${nodeVersion} is too old; Council requires Node.js 24 or newer`,
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

async function resolveDoctorDataHome(): Promise<string> {
  try {
    const config = await loadConfig();
    return getCouncilDataHome(config);
  } catch {
    return getCouncilDataHome();
  }
}

async function checkCouncilDataHome(): Promise<CheckResult> {
  const dataHome = await resolveDoctorDataHome();
  try {
    await ensureDataDirectories(dataHome);
    return { name: "Council data home", status: "pass", detail: dataHome };
  } catch (err: unknown) {
    return {
      name: "Council data home",
      status: "fail",
      detail: `cannot create ${dataHome}: ${formatError(err)}`,
    };
  }
}

async function checkSqlite(): Promise<CheckResult> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    database.prepare("SELECT 1").get();
    database.close();
    return { name: "SQLite (node:sqlite)", status: "pass", detail: "in-memory DB OK" };
  } catch (err: unknown) {
    return {
      name: "SQLite (node:sqlite)",
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

async function checkCopilotCli(
  resolveCliPath: NonNullable<DoctorDeps["resolveCliPath"]>,
): Promise<CheckResult> {
  const probe = checkCopilotCliPath({
    override: process.env.COPILOT_CLI_PATH,
    resolvedPath: resolveCliPath(),
  });
  return {
    name: "Copilot CLI",
    status: probe.status === "needs-remediation" ? "fail" : "pass",
    detail: probe.detail,
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
  return stripControlChars(id)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function isValidModelId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

async function buildModelAccessFailureDetail(
  failureDetail: string,
  model: string,
  discoverModels: NonNullable<DoctorDeps["discoverModels"]>,
): Promise<string> {
  try {
    const discovery = await discoverModels();
    const sanitizedModel = sanitizeModelId(model);
    const alternatives = [
      ...new Set(
        discovery.models
          .map(sanitizeModelId)
          .filter(
            (candidate) =>
              candidate.length > 0 && candidate !== sanitizedModel && isValidModelId(candidate),
          ),
      ),
    ];
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

function isWriter(input: DoctorDeps | Writer): input is Writer {
  return typeof input === "function";
}

function resolveDoctorDeps(input: DoctorDeps | Writer): Required<DoctorDeps> {
  const deps = isWriter(input) ? { write: input } : input;
  return {
    write: deps.write ?? defaultWriter,
    version: deps.version ?? packageJson.version,
    onlineProbe: deps.onlineProbe ?? probeCopilotModel,
    discoverModels: deps.discoverModels ?? discoverAvailableModels,
    createSpinner: deps.createSpinner ?? createSpinner,
    resolveCliPath: deps.resolveCliPath ?? resolveCopilotCliPath,
  };
}

interface ProviderStatus {
  readonly id: ProviderId;
  readonly available: boolean;
  readonly apiKeyEnvVar: string | undefined;
}

/**
 * Snapshot each known provider's availability straight from the engine
 * registry so `doctor` never drifts from what the CLI can actually run. The
 * env-var NAME (never a value) rides along for coming-soon providers.
 */
function collectProviderStatuses(): readonly ProviderStatus[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    available: isProviderAvailable(id),
    apiKeyEnvVar: getProviderApiKeyEnvVar(id),
  }));
}

/** Reduce provider statuses to the coarse, secret-free shape the report ships. */
function toReportProviders(
  statuses: readonly ProviderStatus[],
): readonly DoctorProviderAvailability[] {
  return statuses.map(({ id, available }) => ({ id, available }));
}

/**
 * Render the human-facing "Providers" section: each provider id with whether
 * its adapter is usable today, sourced from the registry so it stays in sync.
 * ASCII mode swaps the em dash for a hyphen, mirroring the sibling sections'
 * symbol handling. Only the env-var NAME is ever shown for coming-soon
 * providers — never a value.
 */
function renderProvidersSection(write: Writer, statuses: readonly ProviderStatus[]): void {
  const sym = getSymbols();
  const dash = collectTerminalCapabilities().ascii ? "-" : "\u2014";
  write(`${sym.info} Providers\n`);
  for (const { id, available, apiKeyEnvVar } of statuses) {
    const status = available ? "available" : "not yet available (coming soon)";
    const keyHint = !available && apiKeyEnvVar !== undefined ? ` [env: ${apiKeyEnvVar}]` : "";
    write(`   ${id} ${dash} ${status}${keyHint}\n`);
  }
}

export function buildDoctorCommand(input: DoctorDeps | Writer = {}): Command {
  const {
    write,
    version,
    onlineProbe,
    discoverModels,
    createSpinner: makeSpinner,
    resolveCliPath,
  } = resolveDoctorDeps(input);
  const cmd = new Command("doctor");
  cmd
    .description("Diagnose Council setup (Node, libsql, Copilot SDK, disk)")
    .option("--online", "No-op; online check now runs by default (backwards compatibility)")
    .option("--offline", "Skip online model probe")
    .option("--models", "List available Copilot models (live discovery with static fallback)")
    .option(
      "--report <format>",
      "Emit a sanitized diagnostic report for bug reports (json|markdown)",
    )
    .action(async (options: DoctorOptions) => {
      const checks: LabeledCheck[] = [
        { label: "Node.js version", run: checkNodeVersion },
        { label: "Council home", run: checkCouncilHome },
        { label: "Council data home", run: checkCouncilDataHome },
        { label: "SQLite (node:sqlite)", run: checkSqlite },
        { label: "Copilot SDK", run: checkCopilotSdk },
        { label: "Copilot CLI", run: () => checkCopilotCli(resolveCliPath) },
        { label: "Disk write", run: checkDiskSpace },
      ];

      // Run online check by default unless --offline is specified
      if (!options.offline) {
        checks.push({
          label: "Default model access",
          run: () => checkDefaultModelAccess(onlineProbe, discoverModels),
        });
      }

      // Sanitized diagnostic report mode (--report json|markdown): emit a
      // paste-ready, redaction-safe payload and exit before any human-facing
      // banner/config/terminal sections (which legitimately echo paths).
      if (options.report !== undefined) {
        const reportFormat = options.report;
        if (!isDoctorReportFormat(reportFormat)) {
          cmd.error('Unknown --report format. Use "json" or "markdown".', {
            exitCode: 1,
            code: "council.doctor.report.invalid",
          });
          return;
        }
        const reportChecks: DoctorReportCheck[] = [];
        for (const { run } of checks) {
          const result = await run();
          reportChecks.push({ name: result.name, status: result.status });
        }
        const copilotCliPathStatus = checkCopilotCliPath({
          override: process.env.COPILOT_CLI_PATH,
          resolvedPath: resolveCliPath(),
        }).status;
        let telemetryEnabled = false;
        try {
          telemetryEnabled = (await loadConfig()).telemetry.enabled;
        } catch {
          telemetryEnabled = false;
        }
        const report = buildDoctorReport({
          cliVersion: version,
          checks: reportChecks,
          copilotCliPathStatus,
          telemetryEnabled,
          providers: toReportProviders(collectProviderStatuses()),
        });
        write(renderDoctorReport(report, reportFormat));
        return;
      }

      write(renderBanner({ version }) + "\n");
      write("\n");
      const sym = getSymbols();
      write(`Platform: ${os.platform()} ${os.arch()}\n`);
      write("\n");

      const spinner = makeSpinner();
      let allPassed = true;
      for (const { label, run } of checks) {
        spinner.start(label);
        let result: CheckResult;
        try {
          result = await run();
        } finally {
          spinner.stop();
        }
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
        const dataHome = getCouncilDataHome(config);
        const sym2 = getSymbols();
        write(
          `${sym2.pass} Config\n` +
            `   Path: ${configFilePath}\n` +
            `   Data home: ${dataHome}\n` +
            `   Engine: ${config.defaults.engine} | Model: ${config.defaults.model} | Rounds: ${config.defaults.maxRounds}\n`,
        );
      } catch {
        const sym2 = getSymbols();
        write(`${sym2.warn} Config\n   Could not load configuration\n`);
      }

      // Provider availability section (T-ecosystem-6): surface which engines
      // are usable today vs coming soon, sourced from the engine registry.
      write("\n");
      renderProvidersSection(write, collectProviderStatuses());

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
        write(formatAvailableModels(modelDiscovery.models, modelDiscovery.source));
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

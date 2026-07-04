/**
 * `council doctor` — diagnose the local Council setup.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";

import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  type CouncilConfig,
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
import { toSingleLineDisplay } from "../strip-control-chars.js";

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

/** Backstop bound for any injected online probe so doctor never hangs. */
const DEFAULT_ONLINE_PROBE_TIMEOUT_MS = 20_000;

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
  readonly onlineProbeTimeoutMs?: number;
  readonly discoverModels?: () => Promise<ModelDiscoveryResult>;
  readonly createSpinner?: () => Spinner;
  readonly resolveCliPath?: () => string | undefined;
  readonly loadConfig?: () => Promise<CouncilConfig>;
  readonly openSqliteDatabase?: () => Promise<SqliteProbeDatabase>;
}

/**
 * Wrap an async loader so it runs at most once per `doctor` invocation and
 * every caller shares that single result (or rejection). `doctor` reads the
 * config from several checks and the summary; memoizing here keeps those to a
 * single disk read while preserving each caller's own error handling.
 */
function memoizeAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => (cached ??= load());
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

async function resolveDoctorDataHome(
  loadConfig: NonNullable<DoctorDeps["loadConfig"]>,
): Promise<string> {
  try {
    const config = await loadConfig();
    return getCouncilDataHome(config);
  } catch {
    return getCouncilDataHome();
  }
}

/**
 * Runtime write targets that `ensureDataDirectories` provisions under the data
 * home. Council's expert/panel saves land in these subdirectories, so `doctor`
 * must probe each one — not just the data-home root — to avoid a false-green
 * when a pre-existing subdir is read-only (`mkdir` is a silent no-op on an
 * existing directory, so creation alone never surfaces the permission split).
 */
const DATA_HOME_WRITE_SUBDIRS = ["experts", "panels"] as const;

async function checkCouncilDataHome(
  loadConfig: NonNullable<DoctorDeps["loadConfig"]>,
): Promise<CheckResult> {
  const dataHome = await resolveDoctorDataHome(loadConfig);
  try {
    await ensureDataDirectories(dataHome);
  } catch (err: unknown) {
    return {
      name: "Council data home",
      status: "fail",
      detail: `cannot create ${dataHome}: ${formatError(err)}`,
    };
  }
  // Probe the data-home root and every runtime write target so a read-only
  // experts/ or panels/ subdirectory surfaces here instead of only failing at
  // the first real expert/panel save. Collect every failure so a single run
  // reports all broken targets rather than stopping at the first (#1992).
  const writeTargets = [
    dataHome,
    ...DATA_HOME_WRITE_SUBDIRS.map((subdir) => path.join(dataHome, subdir)),
  ];
  const unwritable: string[] = [];
  for (const target of writeTargets) {
    try {
      await probeDirectoryWritable(target);
    } catch (err: unknown) {
      unwritable.push(`${target}: ${formatError(err)}`);
    }
  }
  if (unwritable.length > 0) {
    return {
      name: "Council data home",
      status: "fail",
      detail: `cannot write under ${unwritable.join("; ")}`,
    };
  }
  return { name: "Council data home", status: "pass", detail: dataHome };
}

/** Random bytes that make each throwaway write-probe filename unpredictable. */
const PROBE_RANDOM_BYTES = 12;

/**
 * Bounded exclusive-create attempts for a write-probe. A random-name collision
 * is astronomically unlikely, but a pre-existing entry (including an attacker's
 * pre-planted symlink) also surfaces as EEXIST — retrying with a fresh name lets
 * a legitimate probe succeed without ever following or clobbering that entry.
 */
const PROBE_MAX_ATTEMPTS = 10;

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * Verify `dir` is genuinely writable, not merely present. `ensureDataDirectories`
 * relies on `mkdir`, which is a silent no-op when the directory already exists,
 * so a data home that exists but is read-only would report a false-green status
 * and only fail at the first runtime write. Create and immediately remove a
 * throwaway file so `doctor` surfaces the real writability of the directory.
 *
 * Symlink/TOCTOU hardening (#1915): each probe filename embeds cryptographically
 * random bytes so it cannot be guessed or pre-created, and it is opened with
 * `"wx"` (O_CREAT|O_EXCL|O_WRONLY) so a pre-existing entry at the probe path —
 * including a symlink an attacker planted to redirect the write onto a victim
 * file — fails with EEXIST instead of being followed (POSIX never follows a
 * trailing symlink under O_CREAT|O_EXCL). The payload is written THROUGH that
 * exclusive handle (the path is never re-opened), so there is no write-time
 * TOCTOU window, and only the file WE created is unlinked. On EEXIST we retry
 * with a fresh random name rather than following or clobbering the existing
 * entry; EACCES/EROFS and other errors propagate so the directory is reported
 * as not-writable. The best-effort unlink is cleanup only — a successful create
 * and write already proves writability, so unlink failure must not flip that.
 */
async function probeDirectoryWritable(dir: string): Promise<void> {
  let lastEexist: unknown;
  for (let attempt = 0; attempt < PROBE_MAX_ATTEMPTS; attempt += 1) {
    const probe = path.join(
      dir,
      `.council-doctor-write-test-${randomBytes(PROBE_RANDOM_BYTES).toString("hex")}`,
    );

    let handle: FileHandle;
    try {
      handle = await fs.open(probe, "wx", 0o600);
    } catch (err: unknown) {
      if (hasErrorCode(err, "EEXIST")) {
        // The unguessable probe path already exists: an astronomically unlikely
        // random collision, or a file/symlink pre-planted there. Never follow or
        // overwrite it — retry with a fresh random name.
        lastEexist = err;
        continue;
      }
      throw err;
    }

    try {
      await handle.writeFile("ok", "utf-8");
    } finally {
      await handle.close();
    }
    // The write succeeded, so the directory is genuinely writable. Removing our
    // own probe file is best-effort cleanup and must not flip the verdict.
    await fs.unlink(probe).catch(() => undefined);
    return;
  }

  throw new Error(
    `could not create an exclusive write-probe under ${dir} after ${PROBE_MAX_ATTEMPTS} attempts`,
    { cause: lastEexist },
  );
}

async function checkSqlite(
  openDatabase: NonNullable<DoctorDeps["openSqliteDatabase"]>,
): Promise<CheckResult> {
  try {
    const database = await openDatabase();
    // Once construction succeeds the handle owns a native resource, so close it
    // in a finally even if the probe query throws — otherwise a failed prepare/
    // get would leak the connection (#1265).
    try {
      database.prepare("SELECT 1").get();
    } finally {
      database.close();
    }
    return { name: "SQLite (node:sqlite)", status: "pass", detail: "in-memory DB OK" };
  } catch (err: unknown) {
    return {
      name: "SQLite (node:sqlite)",
      status: "fail",
      detail: formatError(err),
    };
  }
}

/** Minimal surface `doctor` needs from a `node:sqlite` handle for its probe. */
interface SqliteProbeDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}

async function openSqliteProbeDatabase(): Promise<SqliteProbeDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(":memory:");
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
  try {
    await probeDirectoryWritable(home);
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
  timeoutMs: number,
  loadConfig: NonNullable<DoctorDeps["loadConfig"]>,
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

  const TIMED_OUT = Symbol("doctor-probe-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const probe = await Promise.race([onlineProbe(model), timeout]);
    if (probe === TIMED_OUT) {
      return {
        name: "Default model access",
        status: "fail",
        detail: await buildModelAccessFailureDetail(
          `Default model (${model}) probe timed out after ${timeoutMs}ms`,
          model,
          discoverModels,
        ),
      };
    }
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  return toSingleLineDisplay(id).trim();
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
  } catch (err: unknown) {
    // Remediation-time discovery failed. Surface a brief note so the degraded
    // path is diagnosable (#751) instead of silently hiding the secondary
    // failure behind the base access error.
    return `${failureDetail}\n   (could not list alternative models: ${formatError(err)})`;
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
    onlineProbeTimeoutMs: deps.onlineProbeTimeoutMs ?? DEFAULT_ONLINE_PROBE_TIMEOUT_MS,
    discoverModels: deps.discoverModels ?? discoverAvailableModels,
    createSpinner: deps.createSpinner ?? createSpinner,
    resolveCliPath: deps.resolveCliPath ?? resolveCopilotCliPath,
    loadConfig: deps.loadConfig ?? loadConfig,
    openSqliteDatabase: deps.openSqliteDatabase ?? openSqliteProbeDatabase,
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
    onlineProbeTimeoutMs,
    discoverModels,
    createSpinner: makeSpinner,
    resolveCliPath,
    loadConfig: loadConfigDep,
    openSqliteDatabase,
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
      // Resolve config once per invocation and thread the shared loader into
      // every check and summary section so it is read from disk only once.
      const loadConfigOnce = memoizeAsync(loadConfigDep);
      // Likewise cache model discovery: a failed default-model probe discovers
      // alternatives and `--models` lists them, but both must share one probe.
      const discoverModelsOnce = memoizeAsync(discoverModels);
      const checks: LabeledCheck[] = [
        { label: "Node.js version", run: checkNodeVersion },
        { label: "Council home", run: checkCouncilHome },
        { label: "Council data home", run: () => checkCouncilDataHome(loadConfigOnce) },
        { label: "SQLite (node:sqlite)", run: () => checkSqlite(openSqliteDatabase) },
        { label: "Copilot SDK", run: checkCopilotSdk },
        { label: "Copilot CLI", run: () => checkCopilotCli(resolveCliPath) },
        { label: "Disk write", run: checkDiskSpace },
      ];

      // Run online check by default unless --offline is specified
      if (!options.offline) {
        checks.push({
          label: "Default model access",
          run: () =>
            checkDefaultModelAccess(
              onlineProbe,
              discoverModelsOnce,
              onlineProbeTimeoutMs,
              loadConfigOnce,
            ),
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
          telemetryEnabled = (await loadConfigOnce()).telemetry.enabled;
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
        const config = await loadConfigOnce();
        const configFilePath = path.join(getCouncilHome(), CONFIG_FILE);
        const dataHome = getCouncilDataHome(config);
        const sym2 = getSymbols();
        write(
          `${sym2.pass} Config\n` +
            `   Path: ${configFilePath}\n` +
            `   Data home: ${toSingleLineDisplay(dataHome)}\n` +
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
      const safeEnv = (key: string): string => toSingleLineDisplay(process.env[key] ?? "(unset)");
      write(`${sym.info} Terminal\n`);
      write(`   TERM: ${safeEnv("TERM")}\n`);
      write(`   COLORTERM: ${safeEnv("COLORTERM")}\n`);
      write(`   NO_COLOR: ${safeEnv("NO_COLOR")}\n`);
      write(`   FORCE_COLOR: ${safeEnv("FORCE_COLOR")}\n`);
      write(`   TTY: ${process.stdout.isTTY ? "yes" : "no"}\n`);
      write(`   Columns: ${process.stdout.columns ?? "(unknown)"}\n`);

      if (options.models) {
        const modelDiscovery = await discoverModelsOnce();
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

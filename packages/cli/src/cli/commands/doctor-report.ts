/**
 * Sanitized diagnostic report for `council doctor --report`.
 *
 * Produces a paste-ready bug-report payload that deliberately EXCLUDES every
 * piece of sensitive material the privacy policy forbids disclosing
 * (PRIVACY.md / docs/TELEMETRY.md): prompts/content, full file paths,
 * usernames, environment variable values, tokens/API keys, SQLite contents,
 * and the full configuration object.
 *
 * Security model — assemble by WHITELIST, never by redaction:
 *   - Only the safe, coarse primitives enumerated by {@link DoctorReport} are
 *     ever serialized. There is no field that carries a path, a username, an
 *     env value, or a raw config object, so none can leak.
 *   - The free-form `detail` strings produced by the underlying doctor checks
 *     legitimately contain absolute paths (Council home, data home, …). They
 *     are dropped here: only each check's `name` + coarse `status` survive.
 *   - The Copilot CLI probe contributes its STATUS CATEGORY
 *     (`ok` | `override` | `needs-remediation`) only — never the resolved path.
 *   - Provider availability is coarse: each entry is the canonical provider id
 *     plus an `available` boolean. The env-var NAME a future adapter would read
 *     (and never its value) is deliberately omitted here — the report carries
 *     only the enum/boolean, never any key material.
 *   - String fields are additionally passed through {@link toSingleLineDisplay}
 *     as defense-in-depth against control-character / ANSI injection.
 */
import * as os from "node:os";

import type { CopilotCliPathStatus } from "../../engine/copilot/health.js";
import { toSingleLineDisplay } from "../strip-control-chars.js";

/** Output formats accepted by `council doctor --report <format>`. */
export const DOCTOR_REPORT_FORMATS = ["json", "markdown"] as const;

export type DoctorReportFormat = (typeof DOCTOR_REPORT_FORMATS)[number];

export type DoctorCheckStatus = "pass" | "warn" | "fail";

/** A single doctor check reduced to the two fields that are safe to publish. */
export interface DoctorReportCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
}

/**
 * Coarse provider availability for the report. Carries only the canonical
 * provider id and whether its adapter is usable today — never an API-key
 * value, env-var name, or any other provider-specific secret.
 */
export interface DoctorProviderAvailability {
  readonly id: string;
  readonly available: boolean;
}

/** Coarse terminal capability booleans — no env values, just predicates. */
export interface DoctorTerminalCapabilities {
  readonly noColor: boolean;
  readonly tty: boolean;
  readonly ascii: boolean;
}

/** The complete, sanitized report payload. Every field here is safe to share. */
export interface DoctorReport {
  readonly cliVersion: string;
  readonly os: { readonly family: string; readonly arch: string };
  readonly node: string;
  readonly terminal: DoctorTerminalCapabilities;
  readonly copilotCliPathStatus: CopilotCliPathStatus;
  readonly telemetryEnabled: boolean;
  readonly providers: readonly DoctorProviderAvailability[];
  readonly checks: readonly DoctorReportCheck[];
}

/** Inputs needed to assemble a report. Environment details default to the host. */
export interface DoctorReportInput {
  readonly cliVersion: string;
  readonly checks: readonly DoctorReportCheck[];
  readonly copilotCliPathStatus: CopilotCliPathStatus;
  readonly telemetryEnabled: boolean;
  readonly providers?: readonly DoctorProviderAvailability[];
  readonly platform?: string;
  readonly arch?: string;
  readonly nodeVersion?: string;
  readonly terminal?: DoctorTerminalCapabilities;
}

/** Narrow an arbitrary string to a supported report format. */
export function isDoctorReportFormat(value: unknown): value is DoctorReportFormat {
  return typeof value === "string" && (DOCTOR_REPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * Derive terminal capability booleans without echoing any environment values.
 *
 * ASCII mode mirrors {@link import("../renderers/symbols.js")} auto-detection:
 * `COUNCIL_ASCII=1`, any non-empty `NO_COLOR`, or `TERM=dumb`.
 */
export function collectTerminalCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  tty = Boolean(process.stdout.isTTY),
): DoctorTerminalCapabilities {
  const noColor = Boolean(env.NO_COLOR);
  const ascii = env.COUNCIL_ASCII === "1" || noColor || env.TERM === "dumb";
  return { noColor, tty, ascii };
}

function safeString(value: string): string {
  return toSingleLineDisplay(value);
}

/**
 * Assemble a sanitized {@link DoctorReport} from already-collected, safe
 * inputs. Only `name` + `status` are read from each check; any other property
 * (e.g. a smuggled `detail` carrying a path) is structurally discarded.
 */
export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  return {
    cliVersion: safeString(input.cliVersion),
    os: {
      family: safeString(input.platform ?? os.platform()),
      arch: safeString(input.arch ?? os.arch()),
    },
    node: safeString(input.nodeVersion ?? process.versions.node),
    terminal: input.terminal ?? collectTerminalCapabilities(),
    copilotCliPathStatus: input.copilotCliPathStatus,
    telemetryEnabled: input.telemetryEnabled,
    providers: (input.providers ?? []).map((provider) => ({
      id: safeString(provider.id),
      available: provider.available,
    })),
    checks: input.checks.map((check) => ({
      name: safeString(check.name),
      status: check.status,
    })),
  };
}

function renderJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function boolText(value: boolean): string {
  return value ? "true" : "false";
}

function renderMarkdown(report: DoctorReport): string {
  const lines: string[] = [
    "### `council doctor` diagnostic report",
    "",
    "_Sanitized for bug reports: contains no file paths, usernames, environment values, secrets, or configuration contents._",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| CLI version | ${report.cliVersion} |`,
    `| OS family | ${report.os.family} |`,
    `| Architecture | ${report.os.arch} |`,
    `| Node.js | ${report.node} |`,
    `| Terminal NO_COLOR | ${boolText(report.terminal.noColor)} |`,
    `| Terminal TTY | ${boolText(report.terminal.tty)} |`,
    `| Terminal ASCII | ${boolText(report.terminal.ascii)} |`,
    `| Copilot CLI path | ${report.copilotCliPathStatus} |`,
    `| Telemetry enabled | ${boolText(report.telemetryEnabled)} |`,
    "",
    "| Provider | Available |",
    "| --- | --- |",
    ...report.providers.map((provider) => `| ${provider.id} | ${boolText(provider.available)} |`),
    "",
    "| Check | Status |",
    "| --- | --- |",
    ...report.checks.map((check) => `| ${check.name} | ${check.status} |`),
    "",
  ];
  return `${lines.join("\n")}`;
}

/** Render a report as parseable JSON or a paste-ready GitHub Markdown section. */
export function renderDoctorReport(report: DoctorReport, format: DoctorReportFormat): string {
  return format === "json" ? renderJson(report) : renderMarkdown(report);
}

/**
 * Provider health and model discovery — the narrow public surface used by
 * CLI diagnostics and setup flows.
 *
 * SDK-coupled probes (`discoverAvailableModels`, `pingProviderHealth`, the
 * `resolveCopilotCliPath` resolver) are re-exported from `adapter.ts` because
 * ESLint's `no-restricted-imports` rule restricts `@github/copilot-sdk`
 * imports to that single file (per AGENTS.md §Boundaries). This file exists
 * as a stable, narrowly-scoped import surface so the CLI never needs to reach
 * into the adapter directly.
 *
 * The Copilot CLI-path *classification* (`checkCopilotCliPath`) lives here
 * rather than in the adapter: it is pure path/string logic with no SDK
 * dependency, so it stays unit-testable in isolation.
 */
import { existsSync } from "node:fs";

export {
  discoverAvailableModels,
  pingProviderHealth,
  resolveCopilotCliPath,
  type ModelDiscoveryResult,
  type ProviderHealth,
} from "./adapter.js";

/**
 * Outcome of classifying how the Copilot CLI entry resolves.
 *
 * - `ok` — a usable CLI entry was resolved.
 * - `override` — the caller pinned `COPILOT_CLI_PATH` to a path that exists; we
 *   defer to it.
 * - `needs-remediation` — the entry is missing (including a pinned
 *   `COPILOT_CLI_PATH` that does not exist) or is the known bogus
 *   `@github/index.js` path the SDK mis-computes on Windows.
 */
export type CopilotCliPathStatus = "ok" | "override" | "needs-remediation";

export interface CopilotCliPathCheck {
  readonly status: CopilotCliPathStatus;
  readonly detail: string;
}

export interface CopilotCliPathProbe {
  /** Value of the `COPILOT_CLI_PATH` env override, if any. */
  readonly override?: string | undefined;
  /** Path computed by the SDK-coupled resolver, if any. */
  readonly resolvedPath?: string | undefined;
  /** Existence predicate; injected for testability (defaults to `existsSync`). */
  readonly exists?: (candidate: string) => boolean;
}

/**
 * Generic, sanitized remediation for an unresolvable Copilot CLI entry.
 *
 * Intentionally free of any resolved path so it never echoes the user's home
 * directory or username (AGENTS.md sanitized-output expectation). References
 * the sanctioned `COPILOT_CLI_PATH` override and the bundled loader by package
 * path only.
 */
export const COPILOT_CLI_REMEDIATION =
  "Copilot CLI entry could not be resolved (known Windows path-resolution issue). " +
  "Set COPILOT_CLI_PATH to the bundled @github/copilot/npm-loader.js, or reinstall the CLI.";

/**
 * Remediation for an explicit `COPILOT_CLI_PATH` override that does not exist on
 * disk. Path-free for the same reason as {@link COPILOT_CLI_REMEDIATION}: the
 * message is rendered verbatim and must never echo the user's override value.
 */
export const COPILOT_CLI_OVERRIDE_MISSING =
  "COPILOT_CLI_PATH is set but points to a path that does not exist. " +
  "Update it to a valid Copilot CLI entry (the bundled @github/copilot/npm-loader.js), " +
  "or unset it to use the auto-resolved CLI.";

/**
 * The SDK mis-resolves the CLI to `…/@github/index.js` (a path that does not
 * exist) when `@github/copilot` is a bin-only loader package. Match it on both
 * POSIX and Windows separators so the check is cross-platform.
 */
const BOGUS_CLI_PATH = /[/\\]@github[/\\]index\.js$/i;

/**
 * Classify a resolved Copilot CLI entry into a doctor-friendly status, without
 * importing the SDK or mutating any environment. An explicit, non-blank
 * `COPILOT_CLI_PATH` override is respected only when it exists on disk; a pinned
 * path that is missing is surfaced as needs-remediation rather than a false pass
 * (#1334). Otherwise the resolved path must be present, not the bogus
 * `@github/index.js`, and exist on disk.
 */
export function checkCopilotCliPath(probe: CopilotCliPathProbe): CopilotCliPathCheck {
  const exists = probe.exists ?? existsSync;

  const override = probe.override?.trim();
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      return { status: "needs-remediation", detail: COPILOT_CLI_OVERRIDE_MISSING };
    }
    return { status: "override", detail: "Using COPILOT_CLI_PATH override" };
  }

  const resolved = probe.resolvedPath;
  if (
    resolved === undefined ||
    resolved === "" ||
    BOGUS_CLI_PATH.test(resolved) ||
    !exists(resolved)
  ) {
    return { status: "needs-remediation", detail: COPILOT_CLI_REMEDIATION };
  }

  return { status: "ok", detail: "Copilot CLI entry resolved" };
}

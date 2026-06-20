/**
 * npm registry version probe for the startup "update available" notifier.
 *
 * Two responsibilities, both designed to be hermetically testable and to
 * NEVER throw:
 *   - `fetchLatestVersion()` reads the published `version` from the npm
 *     registry `/latest` manifest for `@council-ai/cli`.
 *   - `isNewerVersion()` performs a minimal numeric `major.minor.patch`
 *     comparison (pre-release/build suffixes are stripped).
 */

/**
 * The npm registry `/latest` manifest endpoint for `@council-ai/cli`. The
 * scoped package name MUST be URL-encoded (`@council-ai%2Fcli`).
 */
const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@council-ai%2Fcli/latest";

/** Short default timeout so a slow/unreachable registry never stalls startup. */
const DEFAULT_TIMEOUT_MS = 1500;

export interface FetchLatestVersionOptions {
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Abort the request after this many milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * GET the latest published version of `@council-ai/cli` from the npm registry.
 *
 * Returns the `version` string on success, or `null` on ANY failure
 * (network error, non-2xx response, malformed JSON, missing field, an unsafe
 * version that fails {@link isSafeRegistryVersion}, or timeout). This function
 * never throws.
 */
export async function fetchLatestVersion(
  options: FetchLatestVersionOptions = {},
): Promise<string | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  // Never let the abort timer keep the process alive on its own.
  timer.unref?.();

  try {
    const response = await doFetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();
    return extractVersion(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractVersion(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const version = (payload as Record<string, unknown>)["version"];
  if (typeof version === "string" && isSafeRegistryVersion(version)) {
    return version;
  }
  return null;
}

/**
 * Strict allow-list for an untrusted npm-registry `version` string at the trust
 * boundary. A safe version begins with an alphanumeric and contains only the
 * characters used by semver core, pre-release, and build metadata
 * (`[0-9A-Za-z]`, `.`, `-`, `+`). This deliberately excludes whitespace and
 * EVERY control / ANSI / OSC escape byte (`\x00-\x1f`, `\x7f-\x9f`), so a
 * poisoned version can never be rendered to the terminal (title spoof, OSC-52
 * clipboard hijack, screen clear, output forgery) or persisted to the update
 * cache. Reject (`false`) → callers treat it as "no version available".
 */
const SAFE_REGISTRY_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/;

export function isSafeRegistryVersion(value: string): boolean {
  return SAFE_REGISTRY_VERSION_PATTERN.test(value);
}

/**
 * Returns true iff `latest` is a strictly greater `major.minor.patch` than
 * `current`. Pre-release and build suffixes are stripped before comparison.
 * Malformed input yields `false` (never throws).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  if (currentParts === null || latestParts === null) {
    return false;
  }

  const [currentMajor, currentMinor, currentPatch] = currentParts;
  const [latestMajor, latestMinor, latestPatch] = latestParts;

  if (latestMajor !== currentMajor) {
    return latestMajor > currentMajor;
  }
  if (latestMinor !== currentMinor) {
    return latestMinor > currentMinor;
  }
  return latestPatch > currentPatch;
}

function parseVersion(input: string): readonly [number, number, number] | null {
  const core = input.trim().replace(/^v/, "").split(/[-+]/)[0] ?? "";
  const segments = core.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorRaw, minorRaw, patchRaw] = segments;
  if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined) {
    return null;
  }

  const major = parseSegment(majorRaw);
  const minor = parseSegment(minorRaw);
  const patch = parseSegment(patchRaw);
  if (major === null || minor === null || patch === null) {
    return null;
  }

  return [major, minor, patch];
}

function parseSegment(segment: string): number | null {
  if (!/^\d+$/.test(segment)) {
    return null;
  }
  const value = Number.parseInt(segment, 10);
  return Number.isSafeInteger(value) ? value : null;
}

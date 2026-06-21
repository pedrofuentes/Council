/**
 * Tests for the npm registry version probe.
 *
 * Pure + network-injectable functions used by the startup update notifier:
 *   - `fetchLatestVersion()` GETs the npm registry `/latest` manifest for
 *     `council-ai` and returns its `version`, or `null` on ANY error.
 *     It MUST NEVER throw (network failure, non-200, bad JSON, timeout).
 *   - `isNewerVersion()` performs a minimal numeric `major.minor.patch`
 *     compare, returning true iff `latest` is strictly greater than `current`.
 *
 * Hermetic: every test injects a `fetchImpl` — no real network is touched.
 *
 * RED at this commit: src/core/version/registry.ts does not exist.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchLatestVersion,
  isNewerVersion,
  isSafeRegistryVersion,
} from "../../../../src/core/version/registry.js";

const REGISTRY_URL = "https://registry.npmjs.org/council-ai/latest";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isNewerVersion", () => {
  it("returns true when latest is a greater patch", () => {
    expect(isNewerVersion("0.2.1", "0.2.2")).toBe(true);
  });

  it("returns true when latest is a greater minor", () => {
    expect(isNewerVersion("0.2.1", "0.3.0")).toBe(true);
  });

  it("returns true when latest is a greater major", () => {
    expect(isNewerVersion("0.2.1", "1.0.0")).toBe(true);
  });

  it("compares numerically, not lexically", () => {
    expect(isNewerVersion("1.2.0", "1.10.0")).toBe(true);
    expect(isNewerVersion("1.10.0", "1.2.0")).toBe(false);
  });

  it("returns false when versions are equal", () => {
    expect(isNewerVersion("0.2.1", "0.2.1")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewerVersion("0.3.0", "0.2.1")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
  });

  it("strips a pre-release suffix from latest before comparing", () => {
    expect(isNewerVersion("0.2.1", "0.3.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.2.1", "0.2.1-beta.1")).toBe(false);
  });

  it("strips a pre-release suffix from current before comparing", () => {
    expect(isNewerVersion("0.3.0-rc.1", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.2.0-rc.1", "0.3.0")).toBe(true);
  });

  it("tolerates a leading v prefix", () => {
    expect(isNewerVersion("v0.2.1", "v0.3.0")).toBe(true);
  });

  it("returns false (never throws) on malformed input", () => {
    expect(isNewerVersion("abc", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "abc")).toBe(false);
    expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.2.0", "1.2")).toBe(false);
    expect(isNewerVersion("", "")).toBe(false);
    expect(isNewerVersion("1.x.0", "1.2.0")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  it("returns the version string on a 200 manifest", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));

    const result = await fetchLatestVersion({ fetchImpl });

    expect(result).toBe("0.3.0");
  });

  it("requests the unscoped /latest manifest with an abort signal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));

    await fetchLatestVersion({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(REGISTRY_URL);
    expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "not found" }, { status: 404 }));

    expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
  });

  it("returns null when the body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<<<not json>>>", { status: 200 }));

    expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
  });

  it("returns null when the manifest has no version field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "council-ai" }));

    expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
  });

  it("returns null (never throws) when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND registry.npmjs.org");
    });

    await expect(fetchLatestVersion({ fetchImpl })).resolves.toBe(null);
  });

  it("returns null when the request times out", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const pending = fetchLatestVersion({ fetchImpl, timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(1600);

    expect(await pending).toBe(null);
  });
});

describe("isSafeRegistryVersion", () => {
  it("accepts semver core, pre-release, and build metadata", () => {
    expect(isSafeRegistryVersion("1.2.3")).toBe(true);
    expect(isSafeRegistryVersion("1.2.3-beta.1")).toBe(true);
    expect(isSafeRegistryVersion("1.2.3+build.5")).toBe(true);
    expect(isSafeRegistryVersion("v0.2.1")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isSafeRegistryVersion("")).toBe(false);
  });

  it("rejects strings containing control / ANSI / OSC escape bytes", () => {
    expect(isSafeRegistryVersion("2.0.0-\x1b]0;pwned\x07")).toBe(false);
    expect(isSafeRegistryVersion("1.0.0\x1b[2J")).toBe(false);
    expect(isSafeRegistryVersion("1.0.0\x00")).toBe(false);
    expect(isSafeRegistryVersion("1.0.0\x07")).toBe(false);
    expect(isSafeRegistryVersion("\x1b]52;c;cG93bmVk\x07")).toBe(false);
    expect(isSafeRegistryVersion("1.0.0\x9b")).toBe(false);
    expect(isSafeRegistryVersion("1.0.0\x7f")).toBe(false);
  });

  it("rejects whitespace and other out-of-charset bytes", () => {
    expect(isSafeRegistryVersion("1.0.0 ")).toBe(false);
    expect(isSafeRegistryVersion(" 1.0.0")).toBe(false);
    expect(isSafeRegistryVersion("1.0.0\n")).toBe(false);
    expect(isSafeRegistryVersion("-1.0.0")).toBe(false);
  });
});

describe("fetchLatestVersion — registry version validation (trust boundary)", () => {
  it("returns null when the manifest version embeds an OSC escape sequence", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "2.0.0-\x1b]0;pwned\x07" }));

    expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
  });

  it("returns null for any control/escape byte in the manifest version", async () => {
    const malicious = ["1.0.0\x1b[2J", "1.0.0\x00", "1.0.0\x07", "\x1b]52;c;x\x07", "1.0.0\x9b"];

    for (const version of malicious) {
      const fetchImpl = vi.fn(async () => jsonResponse({ version }));
      expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
    }
  });

  it("still returns legitimate semver versions (core, pre-release, build metadata)", async () => {
    for (const version of ["1.2.3", "1.2.3-beta.1", "1.2.3+build.5"]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ version }));
      expect(await fetchLatestVersion({ fetchImpl })).toBe(version);
    }
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { buildSoftwareApplicationLd } from "../../src/config/site";

/**
 * Regression coverage for Head.astro's homepage-only JSON-LD emission (#1406).
 *
 * `Head.astro` (src/components/Head.astro:20-28) computes `isHomepage` from
 * `Astro.url.pathname` and only emits the `SoftwareApplication` JSON-LD
 * `<script>` there. `buildSoftwareApplicationLd()`'s payload shape is unit
 * tested in `src/config/site.test.ts`, but nothing previously exercised the
 * `.astro` gating itself: a change to the homepage-detection logic (or a
 * Starlight `Head` override change) could silently drop the JSON-LD from `/`,
 * or leak it onto every docs page (invalid structured data), and still pass
 * the rest of the suite.
 *
 * This builds the real site once and inspects the emitted HTML for the
 * homepage and two inner docs routes, so the regression can only be caught by
 * exercising actual build output — not by re-testing the pure helper.
 */
const SITE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ASTRO_BIN = fileURLToPath(new URL("../../node_modules/astro/bin/astro.mjs", import.meta.url));

function resolveDist(relative: string): string {
  return fileURLToPath(new URL(`../../dist/${relative}`, import.meta.url));
}

function readDist(relative: string): string {
  return readFileSync(resolveDist(relative), "utf8");
}

/** Extract and parse every JSON-LD `<script>` payload embedded in a page's HTML. */
function extractJsonLd(html: string): readonly unknown[] {
  const scriptPattern = /<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs;
  return [...html.matchAll(scriptPattern)].map((match) => JSON.parse(match[1] ?? "null") as unknown);
}

beforeAll(() => {
  execFileSync(process.execPath, [ASTRO_BIN, "build"], { cwd: SITE_ROOT, stdio: "pipe" });
}, 180_000);

describe("homepage-only JSON-LD emission (build output)", () => {
  it("emits exactly the SoftwareApplication JSON-LD on the homepage", () => {
    expect(existsSync(resolveDist("index.html"))).toBe(true);
    const payloads = extractJsonLd(readDist("index.html"));
    expect(payloads).toEqual([buildSoftwareApplicationLd()]);
  });

  it("does not emit any JSON-LD on an inner docs route (/tutorials/)", () => {
    expect(existsSync(resolveDist("tutorials/index.html"))).toBe(true);
    const html = readDist("tutorials/index.html");
    expect(extractJsonLd(html)).toEqual([]);
    expect(html).not.toContain("application/ld+json");
  });

  it("does not emit any JSON-LD on another inner docs route (/how-to/)", () => {
    expect(existsSync(resolveDist("how-to/index.html"))).toBe(true);
    const html = readDist("how-to/index.html");
    expect(extractJsonLd(html)).toEqual([]);
    expect(html).not.toContain("application/ld+json");
  });
});

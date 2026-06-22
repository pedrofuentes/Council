import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Branding guards for the Council logo.
 *
 * The previous `public/brand/council-logo.svg` shipped truncated (it opened
 * `<svg>` but never closed it), so the homepage hero rendered an XML parse
 * error instead of the emblem. These tests lock in the fix: the site renders a
 * valid PNG (rasterized from the canonical brand emblem), the header shows the
 * emblem beside the title, and no source still points at the malformed SVG.
 */
function resolve(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(resolve(relative), "utf8");
}

const indexMdx = read("../../src/content/docs/index.mdx");
const brandMark = read("../../src/components/BrandMark.astro");
const landingCss = read("../../src/styles/landing.css");
const astroConfig = read("../../astro.config.mjs");

describe("homepage hero logo", () => {
  it("renders the logo as a PNG, not the malformed SVG", () => {
    expect(indexMdx).toContain("council-logo.png");
    expect(indexMdx).not.toContain("council-logo.svg");
  });
});

describe("BrandMark emblem path", () => {
  it("uses a base-aware PNG path, not a base-less SVG", () => {
    expect(brandMark).not.toContain("/brand/council-logo.svg");
    expect(brandMark).toContain("council-logo.png");
    expect(brandMark).toContain("import.meta.env.BASE_URL");
  });
});

describe("landing.css closing emblem", () => {
  it("drops the base-less SVG workaround", () => {
    expect(landingCss).not.toContain("council-logo.svg");
  });
});

describe("Starlight header logo", () => {
  it("shows the emblem beside the title ([emblem] Council)", () => {
    expect(astroConfig).toMatch(/logo:\s*\{/);
    expect(astroConfig).toContain("council-logo");
    expect(astroConfig).toContain("replacesTitle: false");
  });
});

describe("logo PNG assets", () => {
  it("ships byte-identical copies in public/ and src/assets/", () => {
    const publicPng = resolve("../../public/brand/council-logo.png");
    const assetPng = resolve("../../src/assets/council-logo.png");
    expect(existsSync(publicPng)).toBe(true);
    expect(existsSync(assetPng)).toBe(true);
    expect(readFileSync(publicPng).equals(readFileSync(assetPng))).toBe(true);
  });

  it("removes the malformed source SVG", () => {
    expect(existsSync(resolve("../../public/brand/council-logo.svg"))).toBe(false);
  });
});

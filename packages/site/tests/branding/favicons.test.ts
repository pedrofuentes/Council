import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { firstPixelRGBA } from "./png";

/**
 * Favicon / PWA icon set guards.
 *
 * The site ships a full multi-platform icon set (web, Android/PWA, iOS) derived
 * from the Council emblem. These tests lock in the head wiring (all hrefs go
 * through `withBase` so they resolve under the `/Council/` project base), a
 * valid web manifest, and the presence of every icon asset.
 */
function resolve(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(resolve(relative), "utf8");
}

const head = read("../../src/components/Head.astro");

interface WebmanifestIcon {
  readonly sizes?: string;
}

interface Webmanifest {
  readonly name?: string;
  readonly icons?: readonly WebmanifestIcon[];
  readonly background_color?: string;
}

describe("favicon + PWA head tags", () => {
  it("links an apple-touch-icon through withBase", () => {
    expect(head).toContain('rel="apple-touch-icon"');
    expect(head).toContain('withBase("/apple-touch-icon.png")');
  });

  it("links the web app manifest through withBase", () => {
    expect(head).toContain('rel="manifest"');
    expect(head).toContain('withBase("/site.webmanifest")');
  });

  it("links a PNG icon through withBase", () => {
    expect(head).toContain('withBase("/favicon-96x96.png")');
  });

  it("declares a theme-color", () => {
    expect(head).toContain('name="theme-color"');
  });

  it("base-prefixes every favicon href (no bare site-absolute paths)", () => {
    expect(head).not.toMatch(/href="\/(favicon|apple-touch-icon|site\.web)/);
  });
});

describe("web app manifest", () => {
  it("is valid JSON naming Council with 192 and 512 icons", () => {
    const manifest = JSON.parse(read("../../public/site.webmanifest")) as Webmanifest;
    expect(manifest.name).toBe("Council");
    const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("declares the dark brand background color (not white)", () => {
    const manifest = JSON.parse(read("../../public/site.webmanifest")) as Webmanifest;
    expect(manifest.background_color).toBe("#0e1a20");
  });
});

describe("favicon assets", () => {
  const files = [
    "favicon.svg",
    "favicon.ico",
    "favicon-96x96.png",
    "apple-touch-icon.png",
    "web-app-manifest-192x192.png",
    "web-app-manifest-512x512.png",
  ] as const;

  for (const file of files) {
    it(`ships public/${file}`, () => {
      expect(existsSync(resolve(`../../public/${file}`))).toBe(true);
    });
  }
});

describe("app icon backgrounds", () => {
  // iOS home-screen and maskable PWA icons need an opaque fill, but it must be
  // the dark brand tone — never the washed-out near-white background that made
  // the dark emblem look bad.
  const appIcons = [
    "apple-touch-icon.png",
    "web-app-manifest-192x192.png",
    "web-app-manifest-512x512.png",
  ] as const;

  for (const file of appIcons) {
    it(`${file} has an opaque, dark (non-white) background`, () => {
      const [r, g, b, a] = firstPixelRGBA(readFileSync(resolve(`../../public/${file}`)));
      expect(a).toBeGreaterThan(200);
      expect(Math.max(r, g, b)).toBeLessThan(100);
    });
  }

  it("favicon-96x96.png keeps a transparent background", () => {
    const [, , , alpha] = firstPixelRGBA(readFileSync(resolve("../../public/favicon-96x96.png")));
    expect(alpha).toBe(0);
  });
});

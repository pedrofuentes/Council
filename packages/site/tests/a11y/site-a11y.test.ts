import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Accessibility regression guards for the marketing/docs site.
 *
 * These assert the structural a11y guarantees that the build emits — a skip
 * link on the standalone gallery page, keyboard-focusable scrollable code
 * blocks, no prohibited ARIA on the wordmark, and the theme-constant
 * `--council-color-on-accent` ink used for text on the (theme-constant) accent
 * backgrounds. Colour-contrast itself is verified by the browser-based audit in
 * the non-blocking Lighthouse/a11y CI job; here we lock the markup-level facts
 * that can regress silently.
 */
function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const gallery = read("../../src/pages/gallery.astro");
const panelCard = read("../../src/components/PanelCard.astro");
const brandMark = read("../../src/components/BrandMark.astro");
const terminalShowcase = read("../../src/components/landing/TerminalShowcase.astro");
const globalCss = read("../../src/styles/global.css");

describe("gallery page bypass block", () => {
  it("exposes a skip-to-content link", () => {
    expect(gallery).toMatch(/class="skip-link"/);
    expect(gallery).toMatch(/href="#gallery-main"/);
  });

  it("anchors the skip link to the main landmark", () => {
    expect(gallery).toMatch(/<main[^>]*id="gallery-main"/);
  });

  it("keeps the document language declared", () => {
    expect(gallery).toMatch(/<html lang="en">/);
  });
});

describe("keyboard-focusable scrollable code blocks", () => {
  it("makes the panel convene snippet focusable", () => {
    expect(panelCard).toMatch(/<pre[^>]*tabindex="0"/);
  });

  it("makes the landing terminal transcript focusable", () => {
    expect(terminalShowcase).toMatch(/<pre[^>]*tabindex="0"/);
  });
});

describe("wordmark ARIA", () => {
  it("does not put a prohibited aria-label on the generic wordmark span", () => {
    const match = brandMark.match(/<span class="council-wordmark"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("aria-label");
  });
});

describe("on-accent ink token", () => {
  it("defines a theme-constant on-accent ink in global styles", () => {
    expect(globalCss).toMatch(/--council-color-on-accent:/);
  });

  it("uses the on-accent ink for text on the accent pills/badges", () => {
    expect(panelCard).toMatch(/var\(--council-color-on-accent\)/);
    expect(gallery).toMatch(/var\(--council-color-on-accent\)/);
  });
});

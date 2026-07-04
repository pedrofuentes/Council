import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ROUTE_SHORTCUTS } from "../../../src/tui/lib/shortcuts.js";

const here = dirname(fileURLToPath(import.meta.url));
const screensDir = join(here, "../../../src/tui/screens");

function screenSource(file: string): string {
  return readFileSync(join(screensDir, file), "utf8");
}

// A binding whose key is a single lowercase letter or comma is dispatched by the
// owning screen's own `useInput` handler as `input === "<key>"` / `key === "<key>"`.
// Multi-glyph / named keys (Enter, Esc, Tab, Space, ↑↓, Ctrl+S, "n/e", …) are
// handled globally (AppRouter's Esc/nav) or by shared list widgets, so they are
// intentionally out of scope for this static drift guard.
function isScreenDispatchedKey(keys: string): boolean {
  return /^[a-z,]$/.test(keys);
}

function dispatchesKey(source: string, key: string): boolean {
  return new RegExp(`===\\s*"${key}"`).test(source);
}

describe("shortcut metadata ↔ screen handler drift guard (#1703)", () => {
  it("cross-references every shortcut route to a screen source file that exists", () => {
    expect(ROUTE_SHORTCUTS.length).toBeGreaterThan(0);
    for (const entry of ROUTE_SHORTCUTS) {
      expect(entry.screen, `${entry.pattern} is missing a screen cross-ref`).toMatch(/\.tsx$/);
      expect(
        () => screenSource(entry.screen),
        `${entry.pattern} → ${entry.screen} does not resolve to a screen source`,
      ).not.toThrow();
    }
  });

  it("dispatches every advertised single-key command in the mapped screen handler", () => {
    for (const entry of ROUTE_SHORTCUTS) {
      const src = screenSource(entry.screen);
      for (const binding of entry.bindings) {
        if (!isScreenDispatchedKey(binding.keys)) continue;
        expect(
          dispatchesKey(src, binding.keys),
          `${entry.pattern} advertises "${binding.keys} → ${binding.description}" but ${entry.screen} never dispatches it (=== "${binding.keys}")`,
        ).toBe(true);
      }
    }
  });

  it("locks the panel/expert/session detail action keys to their handlers (regression for the shortcuts.ts drift finding)", () => {
    const detailScreens: readonly { readonly pattern: string; readonly keys: readonly string[] }[] =
      [
        { pattern: "/panels/:name", keys: ["c", "m", "d", "v", "a"] },
        { pattern: "/experts/:slug", keys: ["c", "e", "d", "o", "t", "a"] },
        { pattern: "/sessions/:id", keys: ["c", "x", "a"] },
      ];

    for (const { pattern, keys } of detailScreens) {
      const entry = ROUTE_SHORTCUTS.find((e) => e.pattern === pattern);
      expect(entry, `no shortcut entry for ${pattern}`).toBeDefined();
      if (entry === undefined) continue;

      const advertised = entry.bindings.map((b) => b.keys);
      const src = screenSource(entry.screen);
      for (const key of keys) {
        expect(advertised, `${pattern} should advertise "${key}"`).toContain(key);
        expect(
          dispatchesKey(src, key),
          `${pattern} advertises "${key}" but ${entry.screen} never dispatches it`,
        ).toBe(true);
      }
    }
  });
});

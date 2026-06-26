import { describe, expect, it } from "vitest";

import { shortcutsForRoute, type ShortcutBinding } from "../../../src/tui/lib/shortcuts.js";

function keysOf(bindings: readonly ShortcutBinding[]): readonly string[] {
  return bindings.map((b) => b.keys);
}

function find(bindings: readonly ShortcutBinding[], keys: string): ShortcutBinding | undefined {
  return bindings.find((b) => b.keys === keys);
}

describe("shortcutsForRoute", () => {
  it("maps the home route to its quick actions", () => {
    const b = shortcutsForRoute("/");
    expect(find(b, "c")?.description).toBe("Convene");
    expect(find(b, "e")?.description).toBe("New expert");
    expect(find(b, "p")?.description).toBe("New panel");
    expect(keysOf(b)).toContain(",");
  });

  it("maps the panels list route to n/c", () => {
    const b = shortcutsForRoute("/panels");
    expect(find(b, "n")?.description).toBe("New panel");
    expect(find(b, "c")?.description).toBe("Auto-compose");
  });

  it("maps the panel detail route to c/m/d/v and NOT the panels-list actions", () => {
    const b = shortcutsForRoute("/panels/strategy");
    expect(find(b, "c")?.description).toBe("Chat");
    expect(find(b, "m")?.description).toBe("Edit members");
    expect(find(b, "d")?.description).toBe("Delete");
    expect(find(b, "v")?.description).toBe("Convene");
    // bite: the detail route must NOT resolve to the list's "New panel" binding
    expect(b.some((x) => x.description === "New panel")).toBe(false);
  });

  it("resolves the static /panels/new ahead of the /panels/:name param route", () => {
    const b = shortcutsForRoute("/panels/new");
    // panel-create bindings, not panel-detail's "c Chat"
    expect(keysOf(b)).toContain("Tab");
    expect(find(b, "c")).toBeUndefined();
  });

  it("maps the expert detail route to e/d/o/t", () => {
    const b = shortcutsForRoute("/experts/cto");
    expect(keysOf(b)).toEqual(expect.arrayContaining(["e", "d", "o", "t"]));
    expect(find(b, "o")?.description).toBe("Documents");
    expect(find(b, "t")?.description).toBe("Train");
  });

  it("includes a Chat binding with key c on the expert detail route", () => {
    const b = shortcutsForRoute("/experts/some-slug");
    expect(find(b, "c")?.description).toBe("Chat");
  });

  it("resolves the static /experts/new ahead of /experts/:slug", () => {
    const b = shortcutsForRoute("/experts/new");
    expect(b.some((x) => x.description === "Documents")).toBe(false);
    expect(keysOf(b)).toContain("Ctrl+S");
  });

  it("maps the session detail route to c conclude / x export", () => {
    const b = shortcutsForRoute("/sessions/p1");
    expect(find(b, "c")?.description).toBe("Conclude");
    expect(find(b, "x")?.description).toBe("Export");
  });

  it("resolves the session export sub-route distinctly from the detail route", () => {
    const b = shortcutsForRoute("/sessions/p1/export");
    expect(b.some((x) => x.description === "Conclude")).toBe(false);
    // Movement uses the canonical ↑↓ glyph, not the screen-specific j/k.
    expect(keysOf(b)).toContain("↑↓");
    expect(keysOf(b)).not.toContain("j/k");
  });

  it("labels movement consistently as ↑↓ / Move across every scrollable route", () => {
    const movementRoutes = ["/onboarding", "/experts/new", "/settings", "/sessions/p1/export"];
    for (const route of movementRoutes) {
      const move = shortcutsForRoute(route).find((x) => x.description === "Move");
      expect(move, `expected a Move binding on ${route}`).toBeDefined();
      expect(move?.keys).toBe("↑↓");
    }
  });

  it("disambiguates the panel-compose revise action away from the overloaded 'Edit'", () => {
    const b = shortcutsForRoute("/panels/compose");
    expect(find(b, "n/e")?.description).toBe("Revise");
    expect(b.some((x) => x.description === "Edit")).toBe(false);
  });

  it("maps the session conclude route to x Export, r Re-convene, and Esc Back", () => {
    const b = shortcutsForRoute("/sessions/p1/conclude");
    expect(find(b, "x")?.description).toBe("Export");
    expect(find(b, "r")?.description).toBe("Re-convene");
    expect(find(b, "Esc")?.description).toBe("Back");
  });

  it("maps the convene prompt route", () => {
    const b = shortcutsForRoute("/convene/acme");
    expect(find(b, "Enter")?.description).toBe("Estimate");
    expect(find(b, "Esc")?.description).toBe("Cancel");
  });

  it("maps the expert and panel chat routes to send/back", () => {
    for (const path of ["/chat/expert/cto", "/chat/panel/strategy"]) {
      const b = shortcutsForRoute(path);
      expect(find(b, "Enter")?.description).toBe("Send");
      expect(find(b, "Esc")?.description).toBe("Back");
    }
  });

  it("maps the onboarding route", () => {
    const b = shortcutsForRoute("/onboarding");
    expect(find(b, "Enter")?.description).toBe("Confirm");
    expect(find(b, "Esc")?.description).toBe("Skip");
  });

  it("maps the settings route", () => {
    const b = shortcutsForRoute("/settings");
    expect(find(b, "Ctrl+S")?.description).toBe("Save");
  });

  it("returns an empty legend for an unknown route", () => {
    expect(shortcutsForRoute("/totally/unknown/path")).toEqual([]);
  });

  it("returns an empty legend for list routes that only use the global navigation", () => {
    expect(shortcutsForRoute("/sessions")).toEqual([]);
    expect(shortcutsForRoute("/chats")).toEqual([]);
  });

  it("keeps every binding's keys and description non-empty (mapping integrity)", () => {
    const routes = [
      "/",
      "/onboarding",
      "/panels",
      "/panels/new",
      "/panels/compose",
      "/panels/x/members",
      "/panels/x/delete",
      "/panels/strategy",
      "/convene/acme",
      "/convene/acme/run",
      "/experts",
      "/experts/new",
      "/experts/cto/edit",
      "/experts/cto/delete",
      "/experts/cto/docs",
      "/experts/cto/train",
      "/experts/cto",
      "/sessions/p1",
      "/sessions/p1/conclude",
      "/sessions/p1/export",
      "/chat/expert/cto",
      "/chat/panel/strategy",
      "/settings",
    ];
    for (const r of routes) {
      const bindings = shortcutsForRoute(r);
      // every documented route resolves to at least one binding (bite: a dropped
      // route mapping would yield an empty legend here)
      expect(bindings.length).toBeGreaterThan(0);
      for (const binding of bindings) {
        expect(binding.keys.length).toBeGreaterThan(0);
        expect(binding.description.length).toBeGreaterThan(0);
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import { buildPaletteCommands } from "../../../src/tui/adapters/palette-commands.js";

const idsFor = (navId: string): readonly string[] =>
  buildPaletteCommands({ navId }).map((command) => command.id);

describe("buildPaletteCommands", () => {
  it("filters out the current home section and keeps navigation, help, and quit actions", () => {
    expect(idsFor("home")).toEqual([
      "go-panels",
      "go-experts",
      "go-sessions",
      "go-chats",
      "go-settings",
      "new-panel",
      "compose-panel",
      "new-expert",
      "help",
      "quit",
    ]);
  });

  it("filters out the current panels section while keeping home navigation", () => {
    expect(idsFor("panels")).toEqual([
      "go-home",
      "go-experts",
      "go-sessions",
      "go-chats",
      "go-settings",
      "new-panel",
      "compose-panel",
      "new-expert",
      "help",
      "quit",
    ]);
  });

  it("filters out the current chats section while keeping the other sections", () => {
    expect(idsFor("chats")).toEqual([
      "go-home",
      "go-panels",
      "go-experts",
      "go-sessions",
      "go-settings",
      "new-panel",
      "compose-panel",
      "new-expert",
      "help",
      "quit",
    ]);
  });

  it("offers a navigate action for every left-nav section", () => {
    const navIds = ["home", "panels", "experts", "sessions", "chats", "settings"] as const;
    for (const navId of navIds) {
      const ids = new Set([navId, ...idsFor(navId).map((id) => id.replace(/^go-/, ""))]);
      for (const section of navIds) {
        expect(ids.has(section)).toBe(true);
      }
    }
  });

  it("assigns the expected kind to every palette action", () => {
    expect(buildPaletteCommands({ navId: "home" })).toEqual([
      expect.objectContaining({ id: "go-panels", kind: "navigate" }),
      expect.objectContaining({ id: "go-experts", kind: "navigate" }),
      expect.objectContaining({ id: "go-sessions", kind: "navigate" }),
      expect.objectContaining({ id: "go-chats", kind: "navigate" }),
      expect.objectContaining({ id: "go-settings", kind: "navigate" }),
      expect.objectContaining({ id: "new-panel", kind: "navigate", route: "/panels/new" }),
      expect.objectContaining({ id: "compose-panel", kind: "navigate", route: "/panels/compose" }),
      expect.objectContaining({ id: "new-expert", kind: "navigate", route: "/experts/new" }),
      expect.objectContaining({ id: "help", kind: "help" }),
      expect.objectContaining({ id: "quit", kind: "quit" }),
    ]);
  });

  it("keeps the new expert action even when the current section is experts", () => {
    expect(buildPaletteCommands({ navId: "experts" })).toContainEqual(
      expect.objectContaining({ id: "new-expert", label: "New expert", route: "/experts/new" }),
    );
  });

  it("includes a New panel creation verb with route /panels/new", () => {
    const actions = buildPaletteCommands({ navId: "home" });
    expect(actions).toContainEqual(
      expect.objectContaining({ id: "new-panel", label: "New panel", route: "/panels/new", kind: "navigate" }),
    );
  });

  it("includes an Auto-compose a panel creation verb with route /panels/compose", () => {
    const actions = buildPaletteCommands({ navId: "home" });
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: "compose-panel",
        label: "Auto-compose a panel",
        route: "/panels/compose",
        kind: "navigate",
      }),
    );
  });

  it("includes creation verbs regardless of current navId", () => {
    for (const navId of ["home", "panels", "experts", "sessions", "chats", "settings"]) {
      const ids = buildPaletteCommands({ navId }).map((a) => a.id);
      expect(ids).toContain("new-panel");
      expect(ids).toContain("compose-panel");
      expect(ids).toContain("new-expert");
    }
  });

  it("groups creation verbs before help and quit in the returned order", () => {
    const ids = buildPaletteCommands({ navId: "home" }).map((a) => a.id);
    const newPanelIdx = ids.indexOf("new-panel");
    const composePanelIdx = ids.indexOf("compose-panel");
    const newExpertIdx = ids.indexOf("new-expert");
    const helpIdx = ids.indexOf("help");
    const quitIdx = ids.indexOf("quit");
    expect(newPanelIdx).toBeLessThan(helpIdx);
    expect(composePanelIdx).toBeLessThan(helpIdx);
    expect(newExpertIdx).toBeLessThan(helpIdx);
    expect(helpIdx).toBeLessThan(quitIdx);
  });
});

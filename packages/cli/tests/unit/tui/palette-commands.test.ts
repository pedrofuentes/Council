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
});

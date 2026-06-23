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
      "go-settings",
      "help",
      "quit",
    ]);
  });

  it("filters out the current panels section while keeping home navigation", () => {
    expect(idsFor("panels")).toEqual([
      "go-home",
      "go-experts",
      "go-sessions",
      "go-settings",
      "help",
      "quit",
    ]);
  });

  it("assigns the expected kind to every palette action", () => {
    expect(buildPaletteCommands({ navId: "home" })).toEqual([
      expect.objectContaining({ id: "go-panels", kind: "navigate" }),
      expect.objectContaining({ id: "go-experts", kind: "navigate" }),
      expect.objectContaining({ id: "go-sessions", kind: "navigate" }),
      expect.objectContaining({ id: "go-settings", kind: "navigate" }),
      expect.objectContaining({ id: "help", kind: "help" }),
      expect.objectContaining({ id: "quit", kind: "quit" }),
    ]);
  });
});

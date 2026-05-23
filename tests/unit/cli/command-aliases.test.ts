import { describe, expect, it } from "vitest";

import { buildProgram } from "../../../src/bin/council.js";

describe("command aliases", () => {
  describe("panel/panels aliases", () => {
    it("accepts 'panel' as the canonical command", () => {
      const program = buildProgram();
      const panelCommand = program.commands.find((cmd) => cmd.name() === "panel");
      expect(panelCommand).toBeDefined();
    });

    it("accepts 'panels' as an alias for 'panel'", () => {
      const program = buildProgram();
      const panelCommand = program.commands.find((cmd) => cmd.name() === "panel");
      expect(panelCommand?.aliases()).toContain("panels");
    });
  });

  describe("expert/experts aliases", () => {
    it("accepts 'expert' as the canonical command", () => {
      const program = buildProgram();
      const expertCommand = program.commands.find((cmd) => cmd.name() === "expert");
      expect(expertCommand).toBeDefined();
    });

    it("accepts 'experts' as an alias for 'expert'", () => {
      const program = buildProgram();
      const expertCommand = program.commands.find((cmd) => cmd.name() === "expert");
      expect(expertCommand?.aliases()).toContain("experts");
    });
  });

  describe("sessions/history aliases", () => {
    it("accepts 'sessions' as the canonical command", () => {
      const program = buildProgram();
      const sessionsCommand = program.commands.find((cmd) => cmd.name() === "sessions");
      expect(sessionsCommand).toBeDefined();
    });

    it("accepts 'history' as an alias for 'sessions'", () => {
      const program = buildProgram();
      const sessionsCommand = program.commands.find((cmd) => cmd.name() === "sessions");
      expect(sessionsCommand?.aliases()).toContain("history");
    });
  });
});

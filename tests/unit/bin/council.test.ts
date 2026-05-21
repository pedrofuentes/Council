import { describe, expect, it } from "vitest";

import { buildProgram } from "../../../src/bin/council.js";

describe("buildProgram", () => {
  describe("help output grouping", () => {
    it("includes Getting Started section header", () => {
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Getting Started:");
    });

    it("includes Deliberation section header", () => {
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Deliberation:");
    });

    it("includes Conversation section header", () => {
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Conversation:");
    });

    it("includes Library section header", () => {
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Library:");
    });

    it("includes Inspection section header", () => {
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Inspection:");
    });

    it("includes getting-started hint at end", () => {
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("New to Council? Start with: council doctor");
    });

    it("lists doctor first in command list", () => {
      const program = buildProgram();
      const commandNames = program.commands.map((cmd) => cmd.name());

      expect(commandNames[0]).toBe("doctor");
    });

    it("groups commands in correct order", () => {
      const program = buildProgram();
      const commandNames = program.commands.map((cmd) => cmd.name());

      // Getting Started
      expect(commandNames[0]).toBe("doctor");
      expect(commandNames[1]).toBe("config");

      // Deliberation
      expect(commandNames[2]).toBe("convene");
      expect(commandNames[3]).toBe("resume");
      expect(commandNames[4]).toBe("conclude");

      // Conversation
      expect(commandNames[5]).toBe("ask");
      expect(commandNames[6]).toBe("chat");

      // Library
      expect(commandNames[7]).toBe("expert");
      expect(commandNames[8]).toBe("panel");
      expect(commandNames[9]).toBe("templates");

      // Inspection
      expect(commandNames[10]).toBe("sessions");
      expect(commandNames[11]).toBe("memory");
      expect(commandNames[12]).toBe("export");
    });
  });
});

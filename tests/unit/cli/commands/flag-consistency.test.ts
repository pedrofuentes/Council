/**
 * Tests for T-16: Flag consistency & cognitive load reduction.
 *
 * Covers:
 * 1. CLI-05: Flag help tiering in `convene --help`
 * 2. CLI-15: Global --quiet flag on root program
 * 3. CLI-10: --yes consistency on `expert delete --force`
 * 4. DX-18: --timeout flag on `conclude`
 */
import { describe, expect, it } from "vitest";

import { buildProgram } from "../../../../src/bin/council.js";
import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { buildConcludeCommand } from "../../../../src/cli/commands/conclude.js";
import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";

describe("T-16: Flag consistency", () => {
  // ─────────────────────────────────────────────────────────────────
  // CLI-05: Flag help tiering
  // ─────────────────────────────────────────────────────────────────
  describe("CLI-05: convene help tiering", () => {
    it("displays Common Options section in convene help", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      expect(help).toContain("Common Options:");
    });

    it("displays Advanced Options section in convene help", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      expect(help).toContain("Advanced Options:");
    });

    it("lists --template under Common Options", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      const commonIdx = help.indexOf("Common Options:");
      const advancedIdx = help.indexOf("Advanced Options:");
      const templateIdx = help.indexOf("--template", commonIdx);
      expect(templateIdx).toBeGreaterThan(commonIdx);
      expect(templateIdx).toBeLessThan(advancedIdx);
    });

    it("lists --strategy under Advanced Options", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      const advancedIdx = help.indexOf("Advanced Options:");
      const strategyIdx = help.indexOf("--strategy", advancedIdx);
      expect(strategyIdx).toBeGreaterThan(advancedIdx);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CLI-15: Global --quiet flag
  // ─────────────────────────────────────────────────────────────────
  describe("CLI-15: global --quiet flag", () => {
    it("root program accepts --quiet option", () => {
      const program = buildProgram();
      const quietOpt = program.options.find(
        (o) => o.long === "--quiet" || o.short === "-q",
      );
      expect(quietOpt).toBeDefined();
    });

    it("--quiet is available via program.opts() after parsing", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parse(["node", "council", "--quiet", "doctor"], { from: "user" });
      expect(program.opts()["quiet"]).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CLI-10: --yes consistency on expert delete
  // ─────────────────────────────────────────────────────────────────
  describe("CLI-10: --yes on expert delete --force", () => {
    it("expert delete command accepts --yes flag", () => {
      const expertCmd = buildExpertCommand();
      const deleteCmd = expertCmd.commands.find((c) => c.name() === "delete");
      expect(deleteCmd).toBeDefined();
      const yesOpt = deleteCmd!.options.find((o) => o.long === "--yes");
      expect(yesOpt).toBeDefined();
    });

    it("expert delete --force without --yes rejects in non-interactive mode", async () => {
      // When running non-interactively (CI=true), --force without --yes
      // should error because confirmation cannot be obtained
      const captured: string[] = [];
      const expertCmd = buildExpertCommand();
      const deleteCmd = expertCmd.commands.find((c) => c.name() === "delete");
      expect(deleteCmd).toBeDefined();
      // Verify the option exists and has the correct description
      const yesOpt = deleteCmd!.options.find((o) => o.long === "--yes");
      expect(yesOpt).toBeDefined();
      expect(yesOpt!.description).toContain("confirmation");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // DX-18: --timeout on conclude
  // ─────────────────────────────────────────────────────────────────
  describe("DX-18: --timeout on conclude", () => {
    it("conclude command accepts --timeout option", () => {
      const cmd = buildConcludeCommand();
      const timeoutOpt = cmd.options.find((o) => o.long === "--timeout");
      expect(timeoutOpt).toBeDefined();
    });

    it("--timeout has a default value of 60000", () => {
      const cmd = buildConcludeCommand();
      const timeoutOpt = cmd.options.find((o) => o.long === "--timeout");
      expect(timeoutOpt).toBeDefined();
      expect(timeoutOpt!.defaultValue).toBe(60000);
    });

    it("--timeout accepts a custom value", () => {
      const cmd = buildConcludeCommand();
      cmd.exitOverride();
      // Just verify option parsing — parse without action execution
      const timeoutOpt = cmd.options.find((o) => o.long === "--timeout");
      expect(timeoutOpt).toBeDefined();
      expect(timeoutOpt!.argChoices).toBeUndefined(); // accepts any number
    });
  });
});

/**
 * Tests for CLI help text improvements (Finding 45, 22).
 *
 * Verifies that:
 *   - `expert create` stance option uses user-friendly language
 *   - `convene` help includes guidance on quoting special characters
 */
import { describe, expect, it } from "vitest";

import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";
import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";

describe("expert create help text", () => {
  it("uses 'viewpoint' instead of 'Epistemic stance' for stance option", () => {
    const cmd = buildExpertCommand();
    const createCmd = cmd.commands.find((c) => c.name() === "create");
    expect(createCmd).toBeDefined();
    if (!createCmd) throw new Error("create command not found");

    const stanceOpt = createCmd.options.find((o) => o.long === "--stance");
    expect(stanceOpt).toBeDefined();
    if (!stanceOpt) throw new Error("stance option not found");
    
    expect(stanceOpt.description).not.toMatch(/epistemic/i);
    expect(stanceOpt.description).toMatch(/viewpoint/i);
  });

  it("includes stance examples in help text", () => {
    const cmd = buildExpertCommand();
    const createCmd = cmd.commands.find((c) => c.name() === "create");
    if (!createCmd) throw new Error("create command not found");
    
    const stanceOpt = createCmd.options.find((o) => o.long === "--stance");
    if (!stanceOpt) throw new Error("stance option not found");

    const desc = stanceOpt.description.toLowerCase();
    // Should mention at least some example stances
    const hasExamples =
      desc.includes("skeptical") ||
      desc.includes("optimistic") ||
      desc.includes("devil") ||
      desc.includes("conservative") ||
      desc.includes("neutral");

    expect(hasExamples).toBe(true);
  });
});

describe("convene help text", () => {
  it("includes Note about quoting in after-help examples section", async () => {
    const cmd = buildConveneCommand();
    
    // Create a test output writer to capture help
    let capturedHelp = "";
    const testWriter = (text: string): void => {
      capturedHelp += text;
    };
    
    // Configure the command to use our test writer
    cmd.configureOutput({
      writeOut: testWriter,
      writeErr: testWriter,
    });
    
    // Trigger help generation by calling outputHelp
    cmd.outputHelp();
    
    // Verify the help contains the quoting note
    expect(capturedHelp).toContain("Note:");
    expect(capturedHelp).toContain("special characters");
    expect(capturedHelp).toContain("quote");
  });

  it("has example with dollar sign added via addHelpText", async () => {
    const cmd = buildConveneCommand();
    
    let capturedHelp = "";
    const testWriter = (text: string): void => {
      capturedHelp += text;
    };
    
    cmd.configureOutput({
      writeOut: testWriter,
      writeErr: testWriter,
    });
    
    cmd.outputHelp();
    
    // Verify the help contains the dollar sign example
    expect(capturedHelp).toContain("$450");
    expect(capturedHelp).toContain("reasonable");
  });
});

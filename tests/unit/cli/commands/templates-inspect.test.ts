/**
 * Tests for `council templates inspect <name>` (CLI-12).
 *
 * The inspect subcommand shows template detail: description, expert slugs,
 * debate mode, and max rounds.
 */
import { describe, expect, it } from "vitest";

import { buildTemplatesCommand } from "../../../../src/cli/commands/templates.js";

describe("templates inspect", () => {
  it("registers 'inspect' as a subcommand of templates", () => {
    let output = "";
    const cmd = buildTemplatesCommand((s) => {
      output += s;
    });
    const sub = cmd.commands.find((c) => c.name() === "inspect");
    expect(sub).toBeDefined();
    expect(sub!.description()).toMatch(/detail|inspect|info/i);
  });

  it("displays template description, experts, mode, and maxRounds", async () => {
    let output = "";
    const cmd = buildTemplatesCommand((s) => {
      output += s;
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-templates", "inspect", "code-review"]);

    expect(output).toContain("code-review");
    expect(output).toContain("Multi-perspective code review");
    // Expert slugs
    expect(output).toContain("senior");
    expect(output).toContain("security");
    expect(output).toContain("perf");
    expect(output).toContain("maintainer");
    // Mode and rounds
    expect(output).toMatch(/freeform/i);
    expect(output).toContain("3");
  });

  it("errors when template name is not found", async () => {
    let output = "";
    const cmd = buildTemplatesCommand((s) => {
      output += s;
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-templates", "inspect", "nonexistent-template"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toMatch(/not found/i);
  });
});

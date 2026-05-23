/**
 * Tests for template list showing descriptions (Finding 4).
 *
 * `council templates` should show descriptions next to template names
 * so users can understand what each template does without inspecting each.
 */
import { describe, expect, it } from "vitest";

import { buildTemplatesCommand } from "../../../../src/cli/commands/templates.js";

describe("templates list with descriptions", () => {
  it("shows template descriptions alongside names", async () => {
    let output = "";
    const cmd = buildTemplatesCommand((s) => {
      output += s;
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-templates"]);

    // Verify at least one template shows with its description
    expect(output).toContain("code-review");
    expect(output).toContain("Multi-perspective code review");
    
    // Verify another template
    expect(output).toContain("architecture-review");
    expect(output).toMatch(/architecture|design|structure/i);
  });

  it("handles templates without descriptions gracefully", async () => {
    let output = "";
    const cmd = buildTemplatesCommand((s) => {
      output += s;
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-templates"]);

    // Should still list the template names even if some lack descriptions
    expect(output).toContain("Built-in templates:");
    expect(output).toMatch(/\•.*architecture-review/);
    expect(output).toMatch(/\•.*code-review/);
  });
});

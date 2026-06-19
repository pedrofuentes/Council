/**
 * Tests for template list showing descriptions (Finding 4).
 *
 * `council templates` should show descriptions next to template names
 * so users can understand what each template does without inspecting each.
 */
import type * as TemplateLoader from "../../../../src/core/template-loader.js";
import { describe, expect, it, vi } from "vitest";

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
    expect(output).toMatch(/•.*architecture-review/);
    expect(output).toMatch(/•.*code-review/);
  });
});

// Behavioral test for the no-description branch in templates.ts:
// `const desc = panel.description ?? ""; if (desc) { ... } else { ... }`
// Mock the loader so we can exercise the else-branch with a template
// whose description is missing/empty without depending on the bundled
// YAML files (which all happen to have descriptions today).
describe("templates list — no-description branch", () => {
  it("renders bare bullet (no indented description line) when a template has no description", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/core/template-loader.js", async (importOriginal) => {
      const actual = await importOriginal<typeof TemplateLoader>();
      return {
        ...actual,
        listTemplates: async () => ["with-desc", "no-desc"] as readonly string[],
        loadTemplate: async (name: string) => {
          if (name === "with-desc") {
            return {
              name: "with-desc",
              description: "A described panel",
              experts: [],
            };
          }
          return {
            name: "no-desc",
            // description omitted — exercises the `else` branch
            experts: [],
          };
        },
      };
    });

    const { buildTemplatesCommand: build } = await import(
      "../../../../src/cli/commands/templates.js"
    );

    let output = "";
    const cmd = build((s) => {
      output += s;
    });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "council-templates"]);

    // Sanity: both templates are listed.
    expect(output).toContain("• with-desc");
    expect(output).toContain("• no-desc");

    // Described template shows its description on the indented line.
    expect(output).toMatch(/• with-desc\n {4}A described panel/);

    // Undescribed template MUST NOT emit an indented description line.
    // i.e. the next non-empty content after "• no-desc" must be either
    // the trailing "Use with:" hint or end-of-output — never four spaces.
    expect(output).not.toMatch(/• no-desc\n {4}\S/);

    vi.doUnmock("../../../../src/core/template-loader.js");
    vi.resetModules();
  });
});

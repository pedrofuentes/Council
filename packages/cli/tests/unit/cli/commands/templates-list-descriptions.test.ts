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

    const { buildTemplatesCommand: build } =
      await import("../../../../src/cli/commands/templates.js");

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

// ---------------------------------------------------------------------------
// #770 — graceful degradation when a single template fails to load.
//
// `listTemplates()` only does a `readdir`; the per-entry `loadTemplate(name)`
// call in the listing loop now exposes YAML-parse / schema-validation / TOCTOU
// (briefly-missing file) errors. A single failing template MUST NOT abort the
// whole `council templates` listing: the good templates must still be shown,
// the failing one degrades to a name-only bullet, and the genuine error is
// surfaced (not silently lost) as a diagnostic on stderr.
// ---------------------------------------------------------------------------

interface MockPanel {
  readonly name: string;
  readonly description?: string;
  readonly experts: readonly unknown[];
}

/**
 * Drive `council templates` (the listing action) with a mocked template
 * loader, capturing stdout, stderr, and any thrown error (so a crash is
 * observable rather than failing the test with an uncaught rejection).
 */
async function runTemplatesListing(mock: {
  readonly listTemplates: () => Promise<readonly string[]>;
  readonly loadTemplate: (name: string) => Promise<MockPanel>;
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly error: unknown }> {
  vi.resetModules();
  vi.doMock("../../../../src/core/template-loader.js", async (importOriginal) => {
    const actual = await importOriginal<typeof TemplateLoader>();
    return { ...actual, listTemplates: mock.listTemplates, loadTemplate: mock.loadTemplate };
  });
  try {
    const { buildTemplatesCommand: build } =
      await import("../../../../src/cli/commands/templates.js");
    let stdout = "";
    let stderr = "";
    const cmd = build(
      (s) => {
        stdout += s;
      },
      (s) => {
        stderr += s;
      },
    );
    cmd.exitOverride();
    let error: unknown;
    try {
      await cmd.parseAsync(["node", "council-templates"]);
    } catch (err) {
      error = err;
    }
    return { stdout, stderr, error };
  } finally {
    vi.doUnmock("../../../../src/core/template-loader.js");
    vi.resetModules();
  }
}

function validPanel(name: string, description: string): MockPanel {
  return { name, description, experts: [] };
}

describe("templates list — graceful degradation on per-template load failure (#770)", () => {
  // Cover the CLASS of per-entry failures the listing loop now exposes: a
  // malformed YAML parse error, a schema-validation error, and a
  // briefly-missing file (TOCTOU). All must degrade the same way.
  const failureCases: readonly { readonly label: string; readonly loadError: Error }[] = [
    {
      label: "malformed YAML",
      loadError: new Error(
        "Failed to parse panel YAML (/panels/broken.yaml): unexpected end of the stream within a flow collection",
      ),
    },
    {
      label: "schema-invalid",
      loadError: new Error(
        "Invalid panel template in /panels/broken.yaml:\n  - experts: Array must contain at least 1 element(s)",
      ),
    },
    {
      // Real-world source: loadTemplate throws PanelNotFoundError when every
      // candidate file ENOENTs — a file present at readdir time but unlinked
      // before the per-entry load (a TOCTOU race). templates.ts extracts
      // `err.message`, so a plain Error with the same message drives the exact
      // same catch/degrade code path.
      label: "missing file (TOCTOU / not found)",
      loadError: new Error('Panel template "broken" not found.'),
    },
  ];

  it.each(failureCases)(
    "lists the valid templates and degrades the failing one to name-only ($label)",
    async ({ loadError }) => {
      const { stdout, stderr, error } = await runTemplatesListing({
        // Ordered so a VALID template ("good-b") follows the broken one: this
        // proves the loop CONTINUES past the failure instead of aborting.
        listTemplates: async () => ["good-a", "broken", "good-b"] as readonly string[],
        loadTemplate: async (name: string) => {
          if (name === "good-a") return validPanel("good-a", "Alpha panel");
          if (name === "good-b") return validPanel("good-b", "Beta panel");
          throw loadError;
        },
      });

      // 1. The command MUST NOT crash.
      expect(error).toBeUndefined();

      // 2. Both valid templates are fully listed WITH their descriptions —
      //    including the one AFTER the failure (the loop was not aborted).
      expect(stdout).toMatch(/• good-a\n {4}Alpha panel/);
      expect(stdout).toMatch(/• good-b\n {4}Beta panel/);

      // 3. The failing template degrades to a NAME-ONLY bullet: it is still
      //    shown (the user sees it exists) but has NO indented description line.
      expect(stdout).toContain("• broken");
      expect(stdout).not.toMatch(/• broken\n {4}\S/);

      // 4. The command ran to completion (trailing usage hint emitted).
      expect(stdout).toContain("Use with: council convene --template");

      // 5. The genuine error is surfaced (NOT silently lost) as a stderr
      //    diagnostic that names the failing template.
      expect(stderr).toMatch(/Warning: failed to load template "broken":/);
    },
  );

  it("does not swallow valid entries or emit spurious warnings when every template loads", async () => {
    const { stdout, stderr, error } = await runTemplatesListing({
      listTemplates: async () => ["good-a", "good-b"] as readonly string[],
      loadTemplate: async (name: string) =>
        name === "good-a"
          ? validPanel("good-a", "Alpha panel")
          : validPanel("good-b", "Beta panel"),
    });

    // Inverse / load-bearing: the try/catch must NOT suppress real content or
    // fabricate diagnostics for healthy templates.
    expect(error).toBeUndefined();
    expect(stdout).toMatch(/• good-a\n {4}Alpha panel/);
    expect(stdout).toMatch(/• good-b\n {4}Beta panel/);
    expect(stdout).toContain("Use with: council convene --template");
    expect(stderr).toBe("");
  });

  it("sanitizes untrusted template name and error detail in the stderr diagnostic (single-line, control-free)", async () => {
    // A malformed/adversarial YAML file can carry control/bidi/separator bytes
    // in its FILENAME (surfaced by listTemplates) and in the PARSE-ERROR message
    // (which echoes file-derived content). Written verbatim to the one-line
    // stderr sink these could spoof or split the terminal line, so the command
    // MUST sanitize via toSingleLineDisplay.
    const ADVERSARIAL_NAME = "ex\u202Dpl\u007Foit"; // bidi LRO + DEL → "exploit"
    const ADVERSARIAL_DETAIL =
      "boom:\ttab\rcr\nlf\u2028ls\u2029ps\u0007bel\u009bcsi\u007fdel\u202Ebidi";

    const { stdout, stderr, error } = await runTemplatesListing({
      listTemplates: async () => ["good-a", ADVERSARIAL_NAME] as readonly string[],
      loadTemplate: async (name: string) => {
        if (name === "good-a") return validPanel("good-a", "Alpha panel");
        throw new Error(ADVERSARIAL_DETAIL);
      },
    });

    // No crash; the valid template is still listed in full.
    expect(error).toBeUndefined();
    expect(stdout).toMatch(/• good-a\n {4}Alpha panel/);

    // A degradation diagnostic WAS produced for the failing template.
    expect(stderr).toMatch(/Warning: failed to load template/);

    // The diagnostic renders as exactly ONE physical line (only the trailing
    // newline): no injected CR / LF / LS / PS split it.
    expect(stderr.endsWith("\n")).toBe(true);
    expect(stderr.split("\n").filter((line) => line.length > 0)).toHaveLength(1);

    // ...and carries no C0 / DEL / C1 control bytes, bidi overrides, tab, CR, or
    // line/paragraph separators.
    // eslint-disable-next-line no-control-regex
    expect(stderr).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
    expect(stderr).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(stderr).not.toMatch(/[\u2028\u2029]/);
    expect(stderr).not.toContain("\t");
    expect(stderr).not.toContain("\r");

    // The name-only bullet on stdout is likewise sanitized: the raw bidi/DEL
    // bytes from the filename never reach the terminal.
    expect(stdout).toContain("• exploit");
    expect(stdout).not.toContain("\u202D");
    expect(stdout).not.toContain("\u007F");
  });
});

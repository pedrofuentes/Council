/**
 * Tests for CLI command builders.
 *
 * The bin entry (`src/bin/council.ts`) constructs a Commander program from
 * the per-command builders below. Each builder returns a `Command` so we
 * can test:
 *   - The command name + description + options/arguments are correctly registered
 *   - The action handler is invokable with mocked dependencies (engine, sinks, fs)
 *
 * `convene` / `ask` need engine + memory wiring; they're scaffolded here
 * with a no-op handler and will be filled out in a follow-up PR.
 *
 * RED at this commit: src/cli/commands/* does not exist.
 */
import { describe, expect, it } from "vitest";

import { buildPanelsCommand } from "../../../../src/cli/commands/panels.js";
import { buildTemplatesCommand } from "../../../../src/cli/commands/templates.js";
import { buildDoctorCommand } from "../../../../src/cli/commands/doctor.js";

describe("buildPanelsCommand", () => {
  it("registers a 'panels' command with description", () => {
    const cmd = buildPanelsCommand();
    expect(cmd.name()).toBe("panels");
    expect(cmd.description()).toMatch(/list|panels/i);
  });

  it("supports --format json|plain option", () => {
    const cmd = buildPanelsCommand();
    const formatOpt = cmd.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });
});

describe("buildTemplatesCommand", () => {
  it("registers a 'templates' command", () => {
    const cmd = buildTemplatesCommand();
    expect(cmd.name()).toBe("templates");
    expect(cmd.description()).toMatch(/template/i);
  });

  it("lists built-in templates when invoked with --list (default action)", async () => {
    const cmd = buildTemplatesCommand();
    let captured = "";
    cmd.configureOutput({
      writeOut: (s) => {
        captured += s;
      },
      writeErr: () => undefined,
    });
    // Parse with no arguments — defaults to listing
    await cmd.parseAsync(["node", "council-templates"]);
    // Built-in templates from PR #36
    expect(captured).toMatch(/architecture-review/);
    expect(captured).toMatch(/code-review/);
  });
});

describe("buildDoctorCommand", () => {
  it("registers a 'doctor' command", () => {
    const cmd = buildDoctorCommand();
    expect(cmd.name()).toBe("doctor");
    expect(cmd.description()).toMatch(/diagnos|check|setup/i);
  });

  it("runs basic diagnostics and prints results", async () => {
    const cmd = buildDoctorCommand();
    let captured = "";
    cmd.configureOutput({
      writeOut: (s) => {
        captured += s;
      },
      writeErr: (s) => {
        captured += s;
      },
    });
    // Run the doctor; it should not throw even if some checks fail
    await cmd.parseAsync(["node", "council-doctor"]).catch(() => undefined);
    expect(captured.length).toBeGreaterThan(0);
    // Should mention Node version (one of the always-runnable checks)
    expect(captured.toLowerCase()).toMatch(/node/);
  });
});

/**
 * Tests for CLI command builders.
 *
 * The bin entry (`src/bin/council.ts`) constructs a Commander program from
 * the per-command builders below. Each builder returns a `Command` so we
 * can test:
 *   - The command name + description + options/arguments are correctly registered
 *   - The action handler is invokable with mocked dependencies (engine, sinks, fs)
 *
 * Tests for `buildSessionsCommand` (formerly `buildPanelsCommand`) live in
 * `sessions.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { buildTemplatesCommand } from "../../../../src/cli/commands/templates.js";
import { buildDoctorCommand } from "../../../../src/cli/commands/doctor.js";

describe("buildTemplatesCommand", () => {
  it("registers a 'templates' command", () => {
    const cmd = buildTemplatesCommand();
    expect(cmd.name()).toBe("templates");
    expect(cmd.description()).toMatch(/template/i);
  });

  it("lists built-in templates and includes the usage hint", async () => {
    let captured = "";
    const cmd = buildTemplatesCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-templates"]);
    expect(captured).toMatch(/architecture-review/);
    expect(captured).toMatch(/code-review/);
    expect(captured).toMatch(/council convene --template/);
  });
});

describe("buildDoctorCommand", () => {
  it("registers a 'doctor' command", () => {
    const cmd = buildDoctorCommand();
    expect(cmd.name()).toBe("doctor");
    expect(cmd.description()).toMatch(/diagnos|check|setup/i);
  });

  it("runs all five checks and prints the headers", async () => {
    let captured = "";
    const cmd = buildDoctorCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-doctor"]).catch(() => undefined);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.toLowerCase()).toMatch(/node/);
    expect(captured.toLowerCase()).toMatch(/council home/);
    expect(captured.toLowerCase()).toMatch(/sqlite|libsql/);
    expect(captured.toLowerCase()).toMatch(/copilot/);
    expect(captured.toLowerCase()).toMatch(/disk/);
  });
});

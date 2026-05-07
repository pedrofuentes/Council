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
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  describe("action behavior (with isolated COUNCIL_HOME)", () => {
    let testHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panels-test-"));
      originalHome = process.env["COUNCIL_HOME"];
      process.env["COUNCIL_HOME"] = testHome;
    });

    afterEach(async () => {
      if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = originalHome;
      // Best-effort cleanup; libsql may briefly hold WAL handles on Windows
      // even after destroy(). The OS will reap %TEMP% eventually.
      try {
        await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* ignore — temp dir, will be cleaned up by OS */
      }
    });

    it("prints empty-state hint when no panels exist (plain format)", async () => {
      let captured = "";
      const cmd = buildPanelsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panels"]);
      expect(captured.toLowerCase()).toMatch(/no panels|convene/);
    });

    it("emits valid NDJSON (zero lines) when format=json and no panels", async () => {
      let captured = "";
      const cmd = buildPanelsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panels", "--format", "json"]);
      // Empty DB -> zero NDJSON lines (no output, or only trailing newlines)
      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(0);
    });

    it("lists a seeded panel in plain format", async () => {
      // Seed a panel directly via the repo so we don't depend on `convene`
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import(
        "../../../../src/memory/repositories/panels.js"
      );
      const db = await createDatabase(path.join(testHome, "council.db"));
      const repo = new PanelRepository(db);
      await repo.create({
        name: "test-panel",
        topic: "test topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      await db.destroy();

      let captured = "";
      const cmd = buildPanelsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panels"]);
      expect(captured).toContain("test-panel");
      expect(captured).toContain("test topic");
    });

    it("lists a seeded panel as NDJSON when format=json", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import(
        "../../../../src/memory/repositories/panels.js"
      );
      const db = await createDatabase(path.join(testHome, "council.db"));
      const repo = new PanelRepository(db);
      await repo.create({
        name: "another-panel",
        topic: null,
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      await db.destroy();

      let captured = "";
      const cmd = buildPanelsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-panels", "--format", "json"]);
      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.name).toBe("another-panel");
    });
  });
});

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

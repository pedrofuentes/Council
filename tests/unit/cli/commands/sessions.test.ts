/**
 * Tests for `council sessions` (renamed from `council panels`).
 *
 * The command lists debate-session records from Council's local DB. The
 * underlying DB table is still `panels`; only the CLI surface changed.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSessionsCommand } from "../../../../src/cli/commands/sessions.js";
import { buildProgram } from "../../../../src/bin/council.js";

describe("buildSessionsCommand", () => {
  it("registers a 'sessions' command with description", () => {
    const cmd = buildSessionsCommand();
    expect(cmd.name()).toBe("sessions");
    expect(cmd.description()).toMatch(/list|sessions/i);
  });

  it("supports --format json|plain option", () => {
    const cmd = buildSessionsCommand();
    const formatOpt = cmd.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  describe("action behavior (with isolated COUNCIL_HOME)", () => {
    let testHome: string;
    let originalHome: string | undefined;
    let originalDataHome: string | undefined;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-sessions-test-"));
      originalHome = process.env["COUNCIL_HOME"];
      originalDataHome = process.env["COUNCIL_DATA_HOME"];
      process.env["COUNCIL_HOME"] = testHome;
    });

    afterEach(async () => {
      if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = originalHome;
      if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
      // Best-effort cleanup; libsql may briefly hold WAL handles on Windows
      // even after destroy(). The OS will reap %TEMP% eventually.
      try {
        await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* ignore — temp dir, will be cleaned up by OS */
      }
    });

    it("prints empty-state hint when no sessions exist (plain format)", async () => {
      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions"]);
      expect(captured.toLowerCase()).toMatch(/no sessions|convene/);
    });

    it("emits valid NDJSON (zero lines) when format=json and no sessions", async () => {
      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions", "--format", "json"]);
      // Empty DB -> zero NDJSON lines (no output, or only trailing newlines)
      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(0);
    });

    it("lists a seeded session in plain format", async () => {
      // Seed a panel row directly via the repo so we don't depend on `convene`
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const db = await createDatabase(path.join(testHome, "council.db"));
      const repo = new PanelRepository(db);
      await repo.create({
        name: "test-session",
        topic: "test topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      await db.destroy();

      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions"]);
      expect(captured).toContain("test-session");
      expect(captured).toContain("test topic");
    });

    it("shows interrupted debate status distinctly in plain output", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const { DebateRepository } = await import("../../../../src/memory/repositories/debates.js");
      const db = await createDatabase(path.join(testHome, "council.db"));
      const panelRepo = new PanelRepository(db);
      const debateRepo = new DebateRepository(db);
      const panel = await panelRepo.create({
        name: "interrupted-session",
        topic: "partial debate",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      const debate = await debateRepo.create({
        panelId: panel.id,
        prompt: "prompt",
        moderator: "round-robin",
      });
      await debateRepo.update(debate.id, {
        status: "interrupted",
        endedAt: new Date().toISOString(),
      });
      await db.destroy();

      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions"]);
      expect(captured.toLowerCase()).toMatch(/status:\s*interrupted/);
      expect(captured.toLowerCase()).not.toMatch(/status:\s*(completed|running)/);
    });

    it("lists a seeded session as NDJSON when format=json", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const db = await createDatabase(path.join(testHome, "council.db"));
      const repo = new PanelRepository(db);
      await repo.create({
        name: "another-session",
        topic: null,
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      await db.destroy();

      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions", "--format", "json"]);
      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.name).toBe("another-session");
    });

    it("uses COUNCIL_DATA_HOME when COUNCIL_HOME is unset", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const customDataHome = path.join(testHome, "data-home");
      await fs.mkdir(customDataHome, { recursive: true });
      delete process.env["COUNCIL_HOME"];
      process.env["COUNCIL_DATA_HOME"] = customDataHome;

      const db = await createDatabase(path.join(customDataHome, "council.db"));
      const repo = new PanelRepository(db);
      await repo.create({
        name: "data-home-session",
        topic: "env-var topic",
        copilotHome: path.join(customDataHome, "copilot"),
        configJson: "{}",
      });
      await db.destroy();

      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions"]);
      expect(captured).toContain("data-home-session");
      expect(captured).toContain("env-var topic");
    });
  });

  describe("CLI registration in buildProgram()", () => {
    it("registers 'sessions' as a subcommand of the root program", () => {
      const program = buildProgram();
      const found = program.commands.find((c) => c.name() === "sessions");
      expect(found).toBeDefined();
      expect(found?.aliases()).not.toContain("panels");
    });
  });
});

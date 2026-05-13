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

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-sessions-test-"));
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
      const { PanelRepository } = await import(
        "../../../../src/memory/repositories/panels.js"
      );
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

    it("lists a seeded session as NDJSON when format=json", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import(
        "../../../../src/memory/repositories/panels.js"
      );
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
  });
});

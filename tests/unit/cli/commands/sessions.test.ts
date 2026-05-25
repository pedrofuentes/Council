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
import type { DebateStatus } from "../../../../src/memory/repositories/debates.js";

interface SeededPanelDebates {
  readonly panelId: string;
  readonly panelName: string;
  readonly debateIds: readonly string[];
}

async function seedPanelWithDebates(
  testHome: string,
  panelName: string,
  statuses: readonly DebateStatus[],
): Promise<SeededPanelDebates> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { DebateRepository } = await import("../../../../src/memory/repositories/debates.js");
  const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");

  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const debateRepo = new DebateRepository(db);
    const panel = await panelRepo.create({
      name: panelName,
      topic: `${panelName} topic`,
      copilotHome: path.join(testHome, "copilot"),
      configJson: "{}",
    });

    const debateIds: string[] = [];
    for (const [index, status] of statuses.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const debate = await debateRepo.create({
        panelId: panel.id,
        prompt: `${panelName} prompt ${index}`,
        moderator: "round-robin",
      });
      debateIds.push(debate.id);
      if (status !== "running") {
        await debateRepo.update(debate.id, {
          status,
          endedAt: new Date().toISOString(),
        });
      }
    }

    return { panelId: panel.id, panelName: panel.name, debateIds };
  } finally {
    await db.destroy();
  }
}

async function listDebatesForPanel(
  testHome: string,
  panelId: string,
): Promise<readonly { id: string; status: DebateStatus; endedAt: string | null }[]> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { DebateRepository } = await import("../../../../src/memory/repositories/debates.js");

  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const debates = await new DebateRepository(db).findByPanelId(panelId);
    return debates.map((debate) => ({
      id: debate.id,
      status: debate.status,
      endedAt: debate.endedAt,
    }));
  } finally {
    await db.destroy();
  }
}

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

  it("registers a 'cancel' subcommand", () => {
    const cmd = buildSessionsCommand();
    expect(cmd.commands.map((subcommand) => subcommand.name())).toContain("cancel");
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

    it("truncates long topics at ~80 chars in plain format", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import(
        "../../../../src/memory/repositories/panels.js"
      );
      const db = await createDatabase(path.join(testHome, "council.db"));
      const repo = new PanelRepository(db);
      const longTopic =
        "This is a very long topic that should be truncated at approximately 80 characters to fit nicely in the terminal display without wrapping";
      await repo.create({
        name: "long-topic-session",
        topic: longTopic,
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      await db.destroy();

      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync(["node", "council-sessions"]);
      expect(captured).toContain("long-topic-session");
      expect(captured).toContain("...");
      expect(captured).not.toContain(longTopic);
    });

    it("preserves full topic in JSON format", async () => {
      const { createDatabase } = await import("../../../../src/memory/db.js");
      const { PanelRepository } = await import(
        "../../../../src/memory/repositories/panels.js"
      );
      const db = await createDatabase(path.join(testHome, "council.db"));
      const repo = new PanelRepository(db);
      const longTopic =
        "This is a very long topic that should be truncated at approximately 80 characters to fit nicely in the terminal display without wrapping";
      await repo.create({
        name: "json-long-topic",
        topic: longTopic,
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
      expect(parsed.topic).toBe(longTopic);
    });

    it("cancel marks the latest running debate interrupted", async () => {
      const seeded = await seedPanelWithDebates(testHome, "cancel-target", ["running", "running"]);
      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });

      await cmd.parseAsync(["node", "council-sessions", "cancel", "cancel-target"]);

      const debates = await listDebatesForPanel(testHome, seeded.panelId);
      expect(captured).toContain("Cancelled running debate for panel 'cancel-target'.");
      expect(debates).toHaveLength(2);
      expect(debates[0]).toMatchObject({ id: seeded.debateIds[0], status: "running", endedAt: null });
      expect(debates[1]).toMatchObject({ id: seeded.debateIds[1], status: "interrupted" });
      expect(debates[1]?.endedAt).not.toBeNull();
    });

    it("cancel prints a clear message when no running debates exist", async () => {
      const seeded = await seedPanelWithDebates(testHome, "completed-only", ["completed"]);
      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });

      await cmd.parseAsync(["node", "council-sessions", "cancel", "completed-only"]);

      const debates = await listDebatesForPanel(testHome, seeded.panelId);
      expect(captured).toContain("No running debates found for panel 'completed-only'.");
      expect(debates[0]).toMatchObject({ status: "completed" });
    });

    it("cancel resolves a panel by unique prefix", async () => {
      const seeded = await seedPanelWithDebates(testHome, "prefix-target", ["running"]);
      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });

      await cmd.parseAsync(["node", "council-sessions", "cancel", "prefix-ta"]);

      const debates = await listDebatesForPanel(testHome, seeded.panelId);
      expect(captured).toContain("Cancelled running debate for panel 'prefix-target'.");
      expect(debates[0]).toMatchObject({ status: "interrupted" });
      expect(debates[0]?.endedAt).not.toBeNull();
    });

    it("cancel throws when a prefix matches multiple panels", async () => {
      await seedPanelWithDebates(testHome, "prefix-alpha", ["running"]);
      await seedPanelWithDebates(testHome, "prefix-beta", ["running"]);
      const cmd = buildSessionsCommand();

      await expect(cmd.parseAsync(["node", "council-sessions", "cancel", "prefix-"])).rejects.toThrow(
        "Ambiguous prefix 'prefix-' matches 2 panels.",
      );
    });

    it("cancel throws when name is omitted without --all", async () => {
      const cmd = buildSessionsCommand();

      await expect(cmd.parseAsync(["node", "council-sessions", "cancel"])).rejects.toThrow(
        "Panel name is required unless --all is set.",
      );
    });

    it("cancel --all interrupts every running debate", async () => {
      const panelOne = await seedPanelWithDebates(testHome, "all-one", ["running", "completed"]);
      const panelTwo = await seedPanelWithDebates(testHome, "all-two", ["running"]);
      let captured = "";
      const cmd = buildSessionsCommand((s) => {
        captured += s;
      });

      await cmd.parseAsync(["node", "council-sessions", "cancel", "--all"]);

      const panelOneDebates = await listDebatesForPanel(testHome, panelOne.panelId);
      const panelTwoDebates = await listDebatesForPanel(testHome, panelTwo.panelId);
      expect(captured).toContain("Cancelled 2 running debates.");
      expect(panelOneDebates[0]).toMatchObject({ status: "interrupted" });
      expect(panelOneDebates[0]?.endedAt).not.toBeNull();
      expect(panelOneDebates[1]).toMatchObject({ status: "completed" });
      expect(panelTwoDebates[0]).toMatchObject({ status: "interrupted" });
      expect(panelTwoDebates[0]?.endedAt).not.toBeNull();
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

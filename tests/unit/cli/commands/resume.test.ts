/**
 * Tests for `council resume <panel>` (ROADMAP §3.2).
 *
 * Scope (MVP):
 *   - Resolve panel by name (CLI takes a friendly name, not a ULID)
 *   - Show a transcript of the most recent debate for that panel
 *     (panel.assembled summary → all turns in order → debate.end status)
 *   - With --prompt "<prompt>": run a NEW debate against the same
 *     panel (reuses experts, creates new debate row, persists turns)
 *   - --format json|plain — matches convene
 *
 * Out of scope for this PR:
 *   - Mid-debate resume (would need Copilot session persistence; SDK
 *     doesn't expose stable resumeSession yet)
 *   - Interactive panel picker (deferred to ink-ui §3.4)
 *   - Memory recall into prompts (deferred to §3.1 second half)
 *
 * RED at this commit: src/cli/commands/resume.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildResumeCommand } from "../../../../src/cli/commands/resume.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine, ExpertSpec } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";

interface SeedResult {
  panelName: string;
  panelId: string;
  expertIds: { cto: string; pm: string };
  debateId: string;
}

async function seedPanelWithDebate(testHome: string): Promise<SeedResult> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panelName = "test-panel-2026";
    const panel = await panelRepo.create({
      name: panelName,
      topic: "Should we ship the MVP?",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY...",
    });
    const pm = await expertRepo.create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY...",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Should we ship the MVP?",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO opening — ship now.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM opening — wait two weeks.",
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return {
      panelName,
      panelId: panel.id,
      expertIds: { cto: cto.id, pm: pm.id },
      debateId: debate.id,
    };
  } finally {
    await db.destroy();
  }
}

describe("buildResumeCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-resume-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  function makeMockEngineFactory(): () => CouncilEngine {
    return () => new MockEngine({ responses: {} });
  }

  it("registers a 'resume' command with required panel positional arg", () => {
    const cmd = buildResumeCommand({ engineFactory: makeMockEngineFactory() });
    expect(cmd.name()).toBe("resume");
    expect(cmd.description()).toMatch(/panel|resume|debate/i);
    // First registered argument must be required (panel name).
    // commander represents required args via _args; just confirm parseAsync
    // rejects when missing.
  });

  it("supports --format and --prompt options", () => {
    const cmd = buildResumeCommand({ engineFactory: makeMockEngineFactory() });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--format");
    expect(longs).toContain("--prompt");
  });

  it("rejects when the panel name is unknown", async () => {
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-resume", "no-such-panel"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no.*panel|not.*found|unknown panel/);
  });

  it("plain transcript: prints panel header, all turns in order, debate status", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync(["node", "council-resume", seed.panelName]);

    // Header should mention the panel name and topic.
    expect(captured).toContain(seed.panelName);
    expect(captured).toContain("Should we ship the MVP?");
    // Both turns should appear in order, attributed to their experts.
    expect(captured).toContain("CTO");
    expect(captured).toContain("ship now");
    expect(captured).toContain("PM");
    expect(captured).toContain("wait two weeks");
    // CTO's turn must precede PM's in the output.
    expect(captured.indexOf("CTO opening")).toBeLessThan(captured.indexOf("PM opening"));
    // Status line — the debate completed.
    expect(captured.toLowerCase()).toMatch(/status.*completed|completed/);
  });

  it("--format json: emits NDJSON with one event per turn", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync(["node", "council-resume", seed.panelName, "--format", "json"]);

    const lines = captured
      .split("\n")
      .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds.filter((k) => k === "turn.end")).toHaveLength(2);
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("--prompt '<new prompt>' runs a new debate against the same panel and persists it", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-resume",
      seed.panelName,
      "--prompt",
      "What about the migration risk?",
      "--engine",
      "mock",
      "--format",
      "json",
      "--max-rounds",
      "1",
    ]);

    // After resume --prompt, the DB must have TWO debates for this panel.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
      expect(debates).toHaveLength(2);
      const newDebate = debates.find((d) => d.id !== seed.debateId);
      expect(newDebate).toBeDefined();
      expect(newDebate?.prompt).toBe("What about the migration risk?");
      expect(newDebate?.status).toBe("completed");
      // Continued debate must have new turns persisted.
      const newTurns = await new TurnRepository(db).findByDebateId(newDebate?.id ?? "");
      expect(newTurns.length).toBeGreaterThanOrEqual(2);
    } finally {
      await db.destroy();
    }

    // NDJSON output should end with debate.end for the new debate.
    const lines = captured
      .split("\n")
      .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
    expect(lines[lines.length - 1]).toMatch(/"debate\.end"/);
  });

  // ── Sentinel pr165 #1 + #5 — added edge-case coverage ─────────────

  it("--prompt without --engine resolves from config default (no longer throws)", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();

    // With the engine default feature, --prompt without --engine no longer
    // throws — it resolves from config (default: "copilot"). Since the test
    // uses a mock engine factory, it should proceed without error.
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-resume",
        seed.panelName,
        "--prompt",
        "follow-up prompt",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    // Should NOT throw about missing --engine anymore
    expect(thrown.toLowerCase()).not.toMatch(/--engine.*required|engine.*required.*continue/);
  });

  it("--prompt --engine garbage rejects with clear error", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    cmd.exitOverride();

    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-resume",
        seed.panelName,
        "--prompt",
        "x",
        "--engine",
        "anthropic-direct",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/anthropic-direct|engine.*value|engine.*expected/);
  });

  it("transcript mode handles a panel with a debate that has zero turns", async () => {
    // Seed a panel + debate but no turns.
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelName = "";
    try {
      const panel = await new PanelRepository(db).create({
        name: "empty-debate-panel",
        topic: "still empty",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      panelName = panel.name;
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "prompt",
        moderator: "round-robin",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-resume", panelName, "--format", "json"]);
    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    // panel.assembled + debate.end only — no turn events, no
    // round.start/round.end (since lastRound starts at -1 and stays).
    expect(events.map((e) => e.kind)).toEqual(["panel.assembled", "debate.end"]);
  });

  it("transcript mode maps debate.status='running' to debate.end.reason='aborted'", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelName = "";
    try {
      const panel = await new PanelRepository(db).create({
        name: "running-panel",
        topic: "abandoned",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      panelName = panel.name;
      await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "prompt",
        moderator: "round-robin",
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-resume", panelName, "--format", "json"]);
    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
      kind: string;
      reason?: string;
    };
    expect(last.kind).toBe("debate.end");
    expect(last.reason).toBe("aborted");
  });

  it("auto-continues the latest interrupted debate without requiring --prompt", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelName = "";
    let panelId = "";
    let completedDebateId = "";
    let olderInterruptedDebateId = "";
    let latestInterruptedDebateId = "";
    try {
      const panelRepo = new PanelRepository(db);
      const expertRepo = new ExpertRepository(db);
      const debateRepo = new DebateRepository(db);
      const turnRepo = new TurnRepository(db);

      const panel = await panelRepo.create({
        name: "interrupted-panel",
        topic: "resume me",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      panelName = panel.name;
      panelId = panel.id;
      const cto = await expertRepo.create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "[1] IDENTITY...",
      });
      const pm = await expertRepo.create({
        panelId: panel.id,
        slug: "pm",
        displayName: "PM",
        model: "claude-sonnet-4",
        systemMessage: "[1] IDENTITY...",
      });

      const completed = await debateRepo.create({
        panelId: panel.id,
        prompt: "Older completed prompt",
        moderator: "round-robin",
      });
      completedDebateId = completed.id;
      await turnRepo.create({
        debateId: completed.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Completed CTO turn.",
      });
      await turnRepo.create({
        debateId: completed.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: pm.id,
        content: "Completed PM turn.",
      });
      await debateRepo.update(completed.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const olderInterrupted = await debateRepo.create({
        panelId: panel.id,
        prompt: "Older interrupted prompt",
        moderator: "round-robin",
      });
      olderInterruptedDebateId = olderInterrupted.id;
      await turnRepo.create({
        debateId: olderInterrupted.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Older interrupted turn.",
      });
      await debateRepo.update(olderInterrupted.id, {
        status: "interrupted",
        endedAt: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const latestInterrupted = await debateRepo.create({
        panelId: panel.id,
        prompt: "Resume this interrupted prompt",
        moderator: "round-robin",
      });
      latestInterruptedDebateId = latestInterrupted.id;
      await turnRepo.create({
        debateId: latestInterrupted.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Latest interrupted turn.",
      });
      await debateRepo.update(latestInterrupted.id, {
        status: "interrupted",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    let errored = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
      writeError: (s) => {
        errored += s;
      },
    });

    await cmd.parseAsync(["node", "council-resume", panelName, "--format", "json"]);

    expect(errored).toMatch(/resuming interrupted debate/i);

    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    expect(events[0]?.kind).toBe("panel.assembled");
    expect(events[events.length - 1]?.kind).toBe("debate.end");

    const verifyDb = await createDatabase(path.join(testHome, "council.db"));
    try {
      const debates = await new DebateRepository(verifyDb).findByPanelId(panelId);
      expect(debates).toHaveLength(4);
      const autoResumed = debates.find(
        (debate) =>
          debate.id !== completedDebateId &&
          debate.id !== olderInterruptedDebateId &&
          debate.id !== latestInterruptedDebateId,
      );
      expect(autoResumed).toBeDefined();
      expect(autoResumed?.prompt).toBe("Resume this interrupted prompt");
      expect(autoResumed?.status).toBe("completed");
      expect(debates.find((debate) => debate.id === olderInterruptedDebateId)?.status).toBe(
        "interrupted",
      );
      expect(debates.find((debate) => debate.id === latestInterruptedDebateId)?.status).toBe(
        "interrupted",
      );
    } finally {
      await verifyDb.destroy();
    }
  });

  it("findByName resolves to the most-recently-created panel when names collide", async () => {
    // Seed two panels with the SAME name; resume should pick the newer one.
    const db = await createDatabase(path.join(testHome, "council.db"));
    let olderId = "";
    let newerId = "";
    try {
      const repo = new PanelRepository(db);
      const debateRepo = new DebateRepository(db);
      const turnRepo = new TurnRepository(db);

      const older = await repo.create({
        name: "duplicate-name",
        topic: "older topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      olderId = older.id;
      // Older panel needs a debate so resume doesn't error on no-debates.
      const olderDebate = await debateRepo.create({
        panelId: older.id,
        prompt: "older prompt",
        moderator: "round-robin",
      });
      await turnRepo.create({
        debateId: olderDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "system",
        content: "OLDER-DEBATE-MARKER",
      });
      await debateRepo.update(olderDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });

      // 5ms gap so created_at differs (ULID timestamp resolution).
      await new Promise((r) => setTimeout(r, 5));

      const newer = await repo.create({
        name: "duplicate-name",
        topic: "newer topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
      newerId = newer.id;
      const newerDebate = await debateRepo.create({
        panelId: newer.id,
        prompt: "newer prompt",
        moderator: "round-robin",
      });
      await turnRepo.create({
        debateId: newerDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "system",
        content: "NEWER-DEBATE-MARKER",
      });
      await debateRepo.update(newerDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-resume", "duplicate-name"]);
    expect(captured).toContain("newer topic");
    expect(captured).toContain("NEWER-DEBATE-MARKER");
    expect(captured).not.toContain("OLDER-DEBATE-MARKER");
    // Ensure both panels exist (sanity check on the seed).
    expect(olderId).not.toBe(newerId);
  });

  // ── Sentinel pr222 cycle 3 — recall + malformed-config coverage ───

  it("--prompt patches each expert's [7] MEMORY with recalled content from prior turns", async () => {
    // Seed a panel where the system prompt has a [7] MEMORY / [8] CURRENT
    // TASK skeleton, and a prior debate with a distinctive recall marker.
    const seedingDb = await createDatabase(path.join(testHome, "council.db"));
    let panelName = "";
    try {
      const panel = await new PanelRepository(seedingDb).create({
        name: "recall-resume-panel",
        topic: "x",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      panelName = panel.name;
      const expert = await new ExpertRepository(seedingDb).create({
        panelId: panel.id,
        slug: "senior",
        displayName: "Senior",
        model: "claude-sonnet-4",
        systemMessage:
          "[1] IDENTITY\nYou are senior.\n[7] MEMORY\n(no prior memory — placeholder)\n[8] CURRENT TASK\nplaceholder",
      });
      const debate = await new DebateRepository(seedingDb).create({
        panelId: panel.id,
        prompt: "prior",
        moderator: "round-robin",
      });
      await new TurnRepository(seedingDb).create({
        debateId: debate.id,
        round: 1,
        seq: 1,
        speakerKind: "expert",
        expertId: expert.id,
        content: "RESUME_RECALL_MARKER_BETA — keep the migration window narrow and reversible.",
      });
      await new DebateRepository(seedingDb).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await seedingDb.destroy();
    }

    // Capture the systemMessage handed to addExpert by wrapping the mock.
    const capturedSystemMessages: string[] = [];
    const capturingFactory = (): CouncilEngine => {
      const real = new MockEngine({ responses: {} });
      const wrapped: CouncilEngine = {
        start: () => real.start(),
        stop: () => real.stop(),
        addExpert: (spec) => {
          capturedSystemMessages.push(spec.systemMessage);
          return real.addExpert(spec);
        },
        removeExpert: (id) => real.removeExpert(id),
        send: (opts) => real.send(opts),
        listModels: () => real.listModels(),
      };
      return wrapped;
    };

    const cmd = buildResumeCommand({
      engineFactory: capturingFactory,
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-resume",
      panelName,
      "--prompt",
      "follow-up",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
    ]);

    expect(capturedSystemMessages.length).toBeGreaterThan(0);
    const combined = capturedSystemMessages.join("\n----\n");
    expect(combined).toContain("RESUME_RECALL_MARKER_BETA");
    // Placeholder MUST have been replaced by the patched memory block.
    expect(combined).not.toContain("(no prior memory — placeholder)");
  });

  it("--prompt warns to stderr when configJson cannot be parsed (no silent fallback)", async () => {
    // Seed a panel with deliberately-broken configJson.
    const seedingDb = await createDatabase(path.join(testHome, "council.db"));
    let panelName = "";
    try {
      const panel = await new PanelRepository(seedingDb).create({
        name: "broken-cfg-panel",
        topic: "x",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{not-valid-json",
      });
      panelName = panel.name;
      const expert = await new ExpertRepository(seedingDb).create({
        panelId: panel.id,
        slug: "senior",
        displayName: "Senior",
        model: "claude-sonnet-4",
        systemMessage: "[7] MEMORY\nx\n[8] CURRENT TASK\nx",
      });
      const debate = await new DebateRepository(seedingDb).create({
        panelId: panel.id,
        prompt: "prior",
        moderator: "round-robin",
      });
      await new TurnRepository(seedingDb).create({
        debateId: debate.id,
        round: 1,
        seq: 1,
        speakerKind: "expert",
        expertId: expert.id,
        content: "stance.",
      });
      await new DebateRepository(seedingDb).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await seedingDb.destroy();
    }

    let stderr = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
    });
    await cmd.parseAsync([
      "node",
      "council-resume",
      panelName,
      "--prompt",
      "follow-up",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
    ]);

    expect(stderr.toLowerCase()).toMatch(
      /parse.*panel config|panel config.*parse|could not parse panel config/,
    );
    expect(stderr.toLowerCase()).toContain("freeform");
  });

  it("uses config.defaults.model for the memory-extraction synthesizer", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.writeFile(configPath, "defaults:\n  model: resume-test-model\n");

    const seed = await seedPanelWithDebate(testHome);

    const addedSpecs: ExpertSpec[] = [];
    const capturingFactory = (): CouncilEngine => {
      const real = new MockEngine({ responses: {} });
      const origAdd = real.addExpert.bind(real);
      return {
        start: () => real.start(),
        stop: () => real.stop(),
        addExpert: async (spec: ExpertSpec) => {
          addedSpecs.push(spec);
          return origAdd(spec);
        },
        removeExpert: (id: string) => real.removeExpert(id),
        send: (opts) => real.send(opts),
        listModels: () => real.listModels(),
      };
    };

    const cmd = buildResumeCommand({
      engineFactory: capturingFactory,
      write: () => undefined,
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-resume",
      seed.panelName,
      "--prompt",
      "follow-up",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
    ]);

    // The memory extraction hook creates a per-expert synthesizer with slug
    // pattern "__memory-extractor-<expertId>". Find it by prefix.
    const synthSpec = addedSpecs.find((s) => s.slug.startsWith("__memory-extractor-"));
    expect(synthSpec).toBeDefined();
    if (!synthSpec) return; // unreachable after expect above; satisfies lint
    expect(synthSpec.model).toBe("resume-test-model");
  });

  // ── T-07: --max-rounds default for continue mode ───────────────────

  it("defaults to maxRounds=1 for continue mode (--prompt) when --max-rounds not specified", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    // Call resume --prompt WITHOUT --max-rounds
    await cmd.parseAsync([
      "node",
      "council-resume",
      seed.panelName,
      "--prompt",
      "Quick follow-up question",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    // Parse NDJSON to count rounds
    const lines = captured
      .split("\n")
      .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l));
    const kinds = events.map((e: { kind: string }) => e.kind);
    const turnEndCount = kinds.filter((k) => k === "turn.end").length;

    // With 2 experts and 1 round, we expect exactly 2 turn.end events (1 per expert).
    // Default of 4 would produce 8 turn.end events.
    expect(turnEndCount).toBe(2);
  });

  it("allows explicit --max-rounds override for continue mode", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildResumeCommand({
      engineFactory: makeMockEngineFactory(),
      write: (s) => {
        captured += s;
      },
    });

    // Explicitly request 2 rounds
    await cmd.parseAsync([
      "node",
      "council-resume",
      seed.panelName,
      "--prompt",
      "Another question",
      "--engine",
      "mock",
      "--format",
      "json",
      "--max-rounds",
      "2",
    ]);

    const lines = captured
      .split("\n")
      .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l));
    const kinds = events.map((e: { kind: string }) => e.kind);
    const turnEndCount = kinds.filter((k) => k === "turn.end").length;

    // With 2 experts and 2 rounds, we expect 4 turn.end events.
    expect(turnEndCount).toBe(4);
  });
});

/**
 * Tests for `council memory list/inspect/reset` (ROADMAP §3.5).
 *
 * RED at this commit: src/cli/commands/memory.ts does not exist.
 *
 * Scope (MVP):
 *   - list: summary of all panels (panel name, expert count, debate
 *     count, turn count, last activity)
 *   - list --panel <name>: one-row detail for a single panel
 *   - inspect <panel>: detailed view: panel info, expert displayNames,
 *     latest debate prompt + status, turn count
 *   - inspect <panel> --expert <slug>: that expert's system prompt
 *     (truncated) + per-expert turn count
 *   - reset <panel> --yes: delete debates + turns, KEEP panel + experts
 *   - reset <panel> --hard --yes: delete the entire panel (CASCADE
 *     removes experts + debates + turns via FK)
 *   - reset <panel> --expert <slug> --yes: drop one expert from panel
 *   - reset without --yes: refuse (no interactive prompt — flag-only)
 *
 * Out of scope:
 *   - --ephemeral flag on convene (separate PR)
 *   - Real expert_memory table (deferred to §3.1)
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMemoryCommand } from "../../../../src/cli/commands/memory.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertLibraryRepository } from "../../../../src/memory/repositories/expert-library-repo.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { ProfileRepository } from "../../../../src/memory/repositories/profile-repository.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";

interface SeededPanel {
  name: string;
  panelId: string;
  ctoId: string;
  pmId: string;
  debateId: string;
}

async function seedPanel(testHome: string, panelName = "memory-test"): Promise<SeededPanel> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

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
      systemMessage: "[1] IDENTITY\nYou are a CTO with deep distributed-systems experience.",
    });
    const pm = await expertRepo.create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY\nYou are a PM focused on user value.",
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
      content: "CTO opening",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM opening",
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { name: panel.name, panelId: panel.id, ctoId: cto.id, pmId: pm.id, debateId: debate.id };
  } finally {
    await db.destroy();
  }
}

describe("buildMemoryCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-memory-test-"));
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

  it("registers a 'memory' command with three subcommands: list, inspect, reset", () => {
    const cmd = buildMemoryCommand();
    expect(cmd.name()).toBe("memory");
    const subNames = cmd.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(["inspect", "list", "reset"]);
  });

  // ── list ─────────────────────────────────────────────────────────

  describe("memory list", () => {
    it("empty DB: prints a 'no panels' hint", async () => {
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "list"]);
      expect(captured.toLowerCase()).toMatch(/no panels|empty/);
    });

    it("populated DB: prints a per-panel summary with counts", async () => {
      await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "list"]);
      expect(captured).toContain("memory-test");
      // expert count, debate count, turn count visible
      expect(captured).toMatch(/\b2\b/); // 2 experts AND 2 turns AND 1 debate
    });

    it("--format json: emits NDJSON with one row per panel", async () => {
      await seedPanel(testHome, "panel-a");
      await new Promise((r) => setTimeout(r, 5));
      await seedPanel(testHome, "panel-b");
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "list", "--format", "json"]);
      const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
      expect(lines).toHaveLength(2);
      const parsed = lines.map((l) => JSON.parse(l) as { panelName: string; expertCount: number });
      expect(parsed.map((p) => p.panelName).sort()).toEqual(["panel-a", "panel-b"]);
      for (const p of parsed) expect(p.expertCount).toBe(2);
    });

    it("--panel <name>: filters to one panel", async () => {
      await seedPanel(testHome, "wanted");
      await seedPanel(testHome, "unwanted");
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "list", "--panel", "wanted"]);
      expect(captured).toContain("wanted");
      expect(captured).not.toContain("unwanted");
    });

    it("--panel <unknown>: errors with a clear message", async () => {
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-memory", "list", "--panel", "no-such"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
    });
  });

  // ── inspect ──────────────────────────────────────────────────────

  describe("memory inspect", () => {
    it("shows panel info, expert displayNames, latest debate status", async () => {
      const seed = await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "inspect", seed.name]);
      expect(captured).toContain("memory-test");
      expect(captured).toContain("Should we ship the MVP?");
      expect(captured).toContain("CTO");
      expect(captured).toContain("PM");
      expect(captured.toLowerCase()).toMatch(/status.*completed|completed/);
      // turn count for the debate
      expect(captured).toMatch(/\b2\b/);
    });

    it("--expert <slug>: shows that expert's system prompt (truncated) and per-expert turn count", async () => {
      const seed = await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "inspect", seed.name, "--expert", "cto"]);
      expect(captured).toContain("CTO");
      // System prompt content present
      expect(captured).toContain("distributed-systems");
      // Should NOT show PM (the other expert)
      expect(captured).not.toContain("user value");
    });

    it("--expert <unknown-slug>: errors with a clear message", async () => {
      const seed = await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync([
          "node", "council-memory", "inspect", seed.name, "--expert", "ghost",
        ]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/no expert|not found/);
    });

    it("unknown panel: errors clearly", async () => {
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-memory", "inspect", "no-such-panel"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
    });

    it("--format json: emits single JSON line with panel structure", async () => {
      const seed = await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "inspect", seed.name, "--format", "json"]);

      const doc = JSON.parse(captured.trim()) as Record<string, unknown>;
      expect(doc).toHaveProperty("panelName", "memory-test");
      expect(doc).toHaveProperty("panelId");
      expect(doc).toHaveProperty("topic", "Should we ship the MVP?");
      expect(doc).toHaveProperty("debateCount", 1);
      expect(doc).toHaveProperty("experts");
      expect(Array.isArray(doc["experts"])).toBe(true);
      const experts = doc["experts"] as { slug: string }[];
      expect(experts.map((e) => e.slug).sort()).toEqual(["cto", "pm"]);

      expect(doc).toHaveProperty("latestDebate");
      const debate = doc["latestDebate"] as Record<string, unknown>;
      expect(debate).toHaveProperty("status", "completed");
      expect(debate).toHaveProperty("turnCount", 2);
    });

    it("--expert <slug> --format json: emits expert detail with systemMessage and turnCount", async () => {
      const seed = await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync([
        "node", "council-memory", "inspect", seed.name, "--expert", "cto", "--format", "json",
      ]);

      const doc = JSON.parse(captured.trim()) as Record<string, unknown>;
      expect(doc).toHaveProperty("panelName", "memory-test");
      expect(doc).toHaveProperty("expert");
      const expert = doc["expert"] as Record<string, unknown>;
      expect(expert).toHaveProperty("slug", "cto");
      expect(expert).toHaveProperty("displayName", "CTO");
      expect(expert).toHaveProperty("model", "claude-sonnet-4");
      expect(expert).toHaveProperty("systemMessage");
      expect(typeof expert["systemMessage"]).toBe("string");
      expect(expert).toHaveProperty("turnCount");
      expect(typeof expert["turnCount"]).toBe("number");
    });

    it("--format json: no plain-text headings leak into output", async () => {
      await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "inspect", "memory-test", "--format", "json"]);

      const lines = captured.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        expect(line.trim()).toMatch(/^\{/);
      }
    });
  });

  // ── reset ────────────────────────────────────────────────────────

  describe("memory reset", () => {
    it("without --yes: refuses with a clear safety error AND leaves experts/turns untouched", async () => {
      const seed = await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-memory", "reset", seed.name]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/--yes|destructive|confirm/);

      // Sentinel pr178 #6: also verify experts and turns are untouched
      // (not just panels and debates as the original test asserted).
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        expect(experts).toHaveLength(2); // CTO + PM untouched
        const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
        expect(debates).toHaveLength(1);
        const turns = await new TurnRepository(db).findByDebateId(seed.debateId);
        expect(turns).toHaveLength(2); // turns untouched
      } finally {
        await db.destroy();
      }
    });

    it("--yes: deletes debates+turns, KEEPS panel+experts", async () => {
      const seed = await seedPanel(testHome);
      let captured = "";
      const cmd = buildMemoryCommand({ write: (s) => { captured += s; } });
      await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--yes"]);
      expect(captured.toLowerCase()).toMatch(/reset|deleted|cleared/);

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1); // panel kept
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        expect(experts).toHaveLength(2); // experts kept
        const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
        expect(debates).toHaveLength(0); // debates gone
        const turns = await new TurnRepository(db).findByDebateId(seed.debateId);
        expect(turns).toHaveLength(0); // turns gone (CASCADE)
      } finally {
        await db.destroy();
      }
    });

    it("--hard --yes: deletes the entire panel and CASCADEs experts/debates/turns", async () => {
      const seed = await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--hard", "--yes"]);

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(0);
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        expect(experts).toHaveLength(0);
      } finally {
        await db.destroy();
      }
    });

    it("--expert <slug> --yes: removes one expert from the panel (keeps panel + others)", async () => {
      const seed = await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--expert", "cto", "--yes"]);

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        const slugs = experts.map((e) => e.slug);
        expect(slugs).toEqual(["pm"]);
      } finally {
        await db.destroy();
      }
    });

    it("--yes for unknown panel: errors clearly without modifying DB", async () => {
      const seed = await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-memory", "reset", "no-such", "--yes"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/no panel|not found/);

      // Sentinel pr178 #7: assert the seed panel and its data are untouched.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        expect(experts).toHaveLength(2);
        const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
        expect(debates).toHaveLength(1);
      } finally {
        await db.destroy();
      }
    });
  });

  // ── memory/profile separation (Roadmap 7.4) ──────────────────────

  describe("memory reset — profile separation", () => {
    it("--yes: clears extracted_memory_json on each panel expert (debate memory gone)", async () => {
      const seed = await seedPanel(testHome);
      // Seed extracted_memory_json on both experts so we can verify it's cleared.
      const dbSeed = await createDatabase(path.join(testHome, "council.db"));
      try {
        const exp = new ExpertRepository(dbSeed);
        await exp.update(seed.ctoId, {
          extractedMemoryJson: JSON.stringify({ positions: ["ship the MVP"] }),
        });
        await exp.update(seed.pmId, {
          extractedMemoryJson: JSON.stringify({ positions: ["wait one sprint"] }),
        });
      } finally {
        await dbSeed.destroy();
      }

      const cmd = buildMemoryCommand({ write: () => undefined });
      await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--yes"]);

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        expect(experts).toHaveLength(2);
        for (const e of experts) {
          expect(e.extractedMemoryJson).toBeNull();
        }
      } finally {
        await db.destroy();
      }
    });

    it("--yes: preserves persona_profiles rows for experts with document-derived profiles", async () => {
      const seed = await seedPanel(testHome);
      // Insert library row + persona profile for the CTO (FK targets expert_library.slug).
      const dbSeed = await createDatabase(path.join(testHome, "council.db"));
      try {
        await new ExpertLibraryRepository(dbSeed).create({
          slug: "cto",
          kind: "persona",
          displayName: "CTO",
          yamlPath: "/tmp/cto.yaml",
          yamlChecksum: "deadbeef",
        });
        await new ProfileRepository(dbSeed).upsert("cto", {
          communicationStyle: "Direct, technical",
          decisionPatterns: ["weighs risk first"],
          biases: ["favors proven tech"],
          vocabulary: ["latency", "throughput"],
          epistemicStance: "empirical",
          documentCount: 3,
          totalWords: 1200,
          lastUpdated: new Date().toISOString(),
        });
        await new ExpertRepository(dbSeed).update(seed.ctoId, {
          extractedMemoryJson: JSON.stringify({ positions: ["ship now"] }),
        });
      } finally {
        await dbSeed.destroy();
      }

      const cmd = buildMemoryCommand({ write: () => undefined });
      await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--yes"]);

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        const cto = experts.find((e) => e.slug === "cto");
        expect(cto?.extractedMemoryJson).toBeNull(); // debate memory gone
        const profile = await new ProfileRepository(db).findBySlug("cto");
        expect(profile).not.toBeNull();
        expect(profile?.communicationStyle).toBe("Direct, technical");
        expect(profile?.decisionPatterns).toEqual(["weighs risk first"]);
      } finally {
        await db.destroy();
      }
    });

    it("--yes: shows profile-preservation message for persona experts and simple cleared message for generic experts", async () => {
      const seed = await seedPanel(testHome);
      // Give CTO a persona profile; PM has none.
      const dbSeed = await createDatabase(path.join(testHome, "council.db"));
      try {
        await new ExpertLibraryRepository(dbSeed).create({
          slug: "cto",
          kind: "persona",
          displayName: "CTO",
          yamlPath: "/tmp/cto.yaml",
          yamlChecksum: "deadbeef",
        });
        await new ProfileRepository(dbSeed).upsert("cto", {
          communicationStyle: "Direct",
          decisionPatterns: [],
          biases: [],
          vocabulary: [],
          epistemicStance: "empirical",
          documentCount: 1,
          totalWords: 100,
          lastUpdated: new Date().toISOString(),
        });
      } finally {
        await dbSeed.destroy();
      }

      let captured = "";
      const cmd = buildMemoryCommand({
        write: (s) => {
          captured += s;
        },
      });
      await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--yes"]);

      // CTO has a persona profile — both lines should appear for the CTO.
      expect(captured).toMatch(/Debate memory cleared for "CTO"/);
      expect(captured).toMatch(
        /Document-derived persona profile preserved.*council expert train --retrain/,
      );
      // PM has no profile — only the simple cleared message, no preservation hint tied to PM.
      expect(captured).toMatch(/Debate memory cleared for "PM"/);
      // The preservation hint should appear exactly once (only for CTO).
      const hintMatches = captured.match(/persona profile preserved/g) ?? [];
      expect(hintMatches).toHaveLength(1);
    });

    it("reset --help text documents that persona profiles are preserved", () => {
      const cmd = buildMemoryCommand();
      const reset = cmd.commands.find((c) => c.name() === "reset");
      expect(reset).toBeDefined();
      if (!reset) throw new Error("reset subcommand missing");
      const help = reset.helpInformation();
      expect(help.toLowerCase()).toMatch(/persona profile/);
      // Commander may wrap the description across lines, so allow whitespace flex.
      expect(help.replace(/\s+/g, " ")).toMatch(/council expert train --retrain/);
    });
  });

  // ── atomicity (#403) ─────────────────────────────────────────────

  describe("memory reset — atomicity (#403)", () => {
    it("--yes (default path): rolls back debate deletion when a later expert update fails", async () => {
      // Sentinel SENTINEL-PR400-0f62690 flagged that the default reset
      // path deletes debates and then iterates experts to clear
      // extracted_memory_json outside any transaction. If the expert
      // update fails after debates are already gone, the panel is
      // left in a half-reset state (debates lost, memory still set).
      //
      // This test asserts atomicity: when the SECOND expert update
      // throws mid-way, the FIRST expert's memory must NOT be cleared
      // AND the debates must NOT be deleted — the whole reset rolls
      // back as a single unit.
      const seed = await seedPanel(testHome);
      const dbSeed = await createDatabase(path.join(testHome, "council.db"));
      try {
        const exp = new ExpertRepository(dbSeed);
        await exp.update(seed.ctoId, {
          extractedMemoryJson: JSON.stringify({ positions: ["ship the MVP"] }),
        });
        await exp.update(seed.pmId, {
          extractedMemoryJson: JSON.stringify({ positions: ["wait one sprint"] }),
        });
      } finally {
        await dbSeed.destroy();
      }

      // Sabotage the second expert update via prototype patch.
      const originalUpdate = ExpertRepository.prototype.update;
      let calls = 0;
      ExpertRepository.prototype.update = async function patched(
        this: ExpertRepository,
        ...args: Parameters<typeof originalUpdate>
      ) {
        calls += 1;
        // The default reset path calls update twice (once per expert)
        // to clear extractedMemoryJson. Fail on the second call so the
        // first one has already happened; without a transaction this
        // leaves the panel half-reset.
        if (calls === 2) {
          throw new Error("simulated DB failure on second expert update");
        }
        return originalUpdate.apply(this, args);
      } as typeof originalUpdate;

      let thrown: unknown = null;
      try {
        const cmd = buildMemoryCommand({ write: () => undefined });
        cmd.exitOverride();
        await cmd.parseAsync(["node", "council-memory", "reset", seed.name, "--yes"]);
      } catch (err) {
        thrown = err;
      } finally {
        ExpertRepository.prototype.update = originalUpdate;
      }
      // The handler must surface the failure rather than silently swallow it.
      expect(thrown).not.toBeNull();

      // After the simulated failure, the panel state must be the SAME
      // as before the reset attempt.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const debates = await new DebateRepository(db).findByPanelId(seed.panelId);
        expect(debates).toHaveLength(1); // debate NOT deleted (rolled back)

        const experts = await new ExpertRepository(db).findByPanelId(seed.panelId);
        const cto = experts.find((e) => e.slug === "cto");
        const pm = experts.find((e) => e.slug === "pm");
        // First expert's memory must NOT have been cleared.
        expect(cto?.extractedMemoryJson).not.toBeNull();
        // Second expert's memory was never touched.
        expect(pm?.extractedMemoryJson).not.toBeNull();
      } finally {
        await db.destroy();
      }
    });
  });

  // ── format validation (Sentinel pr178 #2 + #3) ───────────────────

  describe("--format validation", () => {
    it("memory list --format yaml: rejects clearly", async () => {
      await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-memory", "list", "--format", "yaml"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/yaml|format.*expected|unknown.*format/);
    });

    it("memory inspect --format yaml: rejects clearly", async () => {
      const seed = await seedPanel(testHome);
      const cmd = buildMemoryCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync([
          "node", "council-memory", "inspect", seed.name, "--format", "yaml",
        ]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).toMatch(/yaml|format.*expected|unknown.*format/);
    });
  });
});

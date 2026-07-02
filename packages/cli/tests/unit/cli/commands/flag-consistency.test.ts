/**
 * Tests for T-16: Flag consistency & cognitive load reduction.
 *
 * Covers:
 * 1. CLI-05: Flag help tiering in `convene --help`
 * 2. CLI-15: Global --quiet flag on root program
 * 3. CLI-10: --yes consistency on `expert delete --force`
 * 4. DX-18: --timeout flag on `conclude`
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../../../src/bin/council.js";
import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import {
  buildConcludeCommand,
  SYNTHESIS_TIMEOUT_MS,
} from "../../../../src/cli/commands/conclude.js";
import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";

describe("T-16: Flag consistency", () => {
  // ─────────────────────────────────────────────────────────────────
  // CLI-05: Flag help tiering
  // ─────────────────────────────────────────────────────────────────
  describe("CLI-05: convene help tiering", () => {
    it("displays Common Options section in convene help", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      expect(help).toContain("Common Options:");
    });

    it("displays Advanced Options section in convene help", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      expect(help).toContain("Advanced Options:");
    });

    it("lists --template under Common Options", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      const commonIdx = help.indexOf("Common Options:");
      const advancedIdx = help.indexOf("Advanced Options:");
      const templateIdx = help.indexOf("--template", commonIdx);
      expect(templateIdx).toBeGreaterThan(commonIdx);
      expect(templateIdx).toBeLessThan(advancedIdx);
    });

    it("lists --strategy under Advanced Options", () => {
      const cmd = buildConveneCommand();
      const help = cmd.helpInformation();
      const advancedIdx = help.indexOf("Advanced Options:");
      const strategyIdx = help.indexOf("--strategy", advancedIdx);
      expect(strategyIdx).toBeGreaterThan(advancedIdx);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CLI-15: Global --quiet flag
  // ─────────────────────────────────────────────────────────────────
  describe("CLI-15: global --quiet flag", () => {
    it("root program accepts --quiet option with -q shorthand", () => {
      const program = buildProgram();
      const quietOpt = program.options.find((o) => o.long === "--quiet");
      expect(quietOpt).toBeDefined();
      expect(quietOpt?.short).toBe("-q");
      expect(quietOpt?.description).toContain("stderr");
    });

    it("advertises cost-indicator suppression in --quiet description (#850)", () => {
      // `--quiet` also suppresses the rendered `[Premium requests: ...]` cost
      // indicator (see PlainRenderer's `cost.update` handler), not just
      // informational stderr notices, so its help text must mention cost.
      const program = buildProgram();
      const quietOpt = program.options.find((o) => o.long === "--quiet");
      expect(quietOpt?.description).toMatch(/cost/i);
    });

    it("--quiet parses to opts().quiet === true", () => {
      const program = buildProgram();
      // Use a hook on the "doctor" command to capture parent opts
      let capturedQuiet: boolean | undefined;
      const doctorCmd = program.commands.find((c) => c.name() === "doctor");
      expect(doctorCmd).toBeDefined();
      // Replace the action to avoid running doctor checks
      doctorCmd?.action(() => {
        capturedQuiet = program.opts()["quiet"] as boolean;
      });
      program.parse(["node", "council", "--quiet", "doctor"]);
      expect(capturedQuiet).toBe(true);
    });

    it("-q shorthand parses to opts().quiet === true", () => {
      const program = buildProgram();
      let capturedQuiet: boolean | undefined;
      const doctorCmd = program.commands.find((c) => c.name() === "doctor");
      expect(doctorCmd).toBeDefined();
      doctorCmd?.action(() => {
        capturedQuiet = program.opts()["quiet"] as boolean;
      });
      program.parse(["node", "council", "-q", "doctor"]);
      expect(capturedQuiet).toBe(true);
    });

    it("quiet defaults to undefined when not specified", () => {
      const program = buildProgram();
      let capturedQuiet: unknown;
      const doctorCmd = program.commands.find((c) => c.name() === "doctor");
      expect(doctorCmd).toBeDefined();
      doctorCmd?.action(() => {
        capturedQuiet = program.opts()["quiet"];
      });
      program.parse(["node", "council", "doctor"]);
      expect(capturedQuiet).toBeUndefined();
    });

    it("default writers use explicit UTF-8 encoding", async () => {
      const { defaultWriter, defaultErrorWriter, defaultNoticeWriter, setQuiet } = await import(
        "../../../../src/cli/commands/writer.js"
      );
      const stdoutCalls: { chunk: string; encoding: BufferEncoding | undefined }[] = [];
      const stderrCalls: { chunk: string; encoding: BufferEncoding | undefined }[] = [];
      const origStdoutWrite = process.stdout.write;
      const origStderrWrite = process.stderr.write;
      process.stdout.write = (((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void)) => {
        stdoutCalls.push({
          chunk: typeof chunk === "string" ? chunk : chunk.toString("utf8"),
          encoding: typeof encoding === "string" ? encoding : undefined,
        });
        return true;
      }) as typeof process.stdout.write);
      process.stderr.write = (((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void)) => {
        stderrCalls.push({
          chunk: typeof chunk === "string" ? chunk : chunk.toString("utf8"),
          encoding: typeof encoding === "string" ? encoding : undefined,
        });
        return true;
      }) as typeof process.stderr.write);

      try {
        setQuiet(false);
        defaultWriter("unicode — 2× ≥ 🎉");
        defaultNoticeWriter("notice — 2× ≥ 🎉");
        defaultErrorWriter("error — 2× ≥ 🎉");
      } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
        setQuiet(false);
      }

      expect(stdoutCalls).toEqual([{ chunk: "unicode — 2× ≥ 🎉", encoding: "utf8" }]);
      expect(stderrCalls).toEqual([
        { chunk: "notice — 2× ≥ 🎉", encoding: "utf8" },
        { chunk: "error — 2× ≥ 🎉", encoding: "utf8" },
      ]);
    });

    it("--quiet suppresses defaultNoticeWriter output but keeps defaultErrorWriter", async () => {
      const { setQuiet, defaultNoticeWriter, defaultErrorWriter, isQuiet } = await import(
        "../../../../src/cli/commands/writer.js"
      );
      // Reset state
      setQuiet(false);
      expect(isQuiet()).toBe(false);

      // Capture stderr via spy
      const written: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((s: string) => {
        written.push(s);
        return true;
      }) as typeof process.stderr.write;

      try {
        // Without quiet: notices are emitted
        defaultNoticeWriter("info message 1");
        expect(written).toContain("info message 1");

        // Enable quiet
        setQuiet(true);
        expect(isQuiet()).toBe(true);

        // Notice is suppressed
        defaultNoticeWriter("info message 2");
        expect(written).not.toContain("info message 2");

        // Error is NOT suppressed — critical errors always shown
        defaultErrorWriter("error message");
        expect(written).toContain("error message");
      } finally {
        process.stderr.write = origWrite;
        setQuiet(false);
      }
    });

    it("buildProgram --quiet wires setQuiet via preAction hook", async () => {
      const { isQuiet, setQuiet } = await import("../../../../src/cli/commands/writer.js");
      setQuiet(false);

      const program = buildProgram();
      // Replace doctor action to avoid side effects
      const doctorCmd = program.commands.find((c) => c.name() === "doctor");
      expect(doctorCmd).toBeDefined();
      doctorCmd?.action(() => {
        // At this point, preAction should have already run
      });

      // Parse with --quiet — preAction hook should call setQuiet(true)
      program.parse(["node", "council", "--quiet", "doctor"]);
      expect(isQuiet()).toBe(true);

      // Cleanup
      setQuiet(false);
    });

    it("preAction resets quiet to false when --quiet is not passed", async () => {
      const { isQuiet, setQuiet } = await import("../../../../src/cli/commands/writer.js");
      // Simulate a leaked quiet state from a prior parse
      setQuiet(true);
      expect(isQuiet()).toBe(true);

      const program = buildProgram();
      const doctorCmd = program.commands.find((c) => c.name() === "doctor");
      expect(doctorCmd).toBeDefined();
      doctorCmd?.action(() => {
        // noop
      });

      // Parse WITHOUT --quiet — preAction should reset quietMode to false
      program.parse(["node", "council", "doctor"]);
      expect(isQuiet()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CLI-10: --yes consistency on expert delete
  // ─────────────────────────────────────────────────────────────────
  describe("CLI-10: --yes on expert delete --force", () => {
    let testHome: string;
    let originalHome: string | undefined;
    let originalDataHome: string | undefined;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-flag-test-"));
      originalHome = process.env["COUNCIL_HOME"];
      originalDataHome = process.env["COUNCIL_DATA_HOME"];
      process.env["COUNCIL_HOME"] = testHome;
      process.env["COUNCIL_DATA_HOME"] = path.join(testHome, "data");
      await fs.mkdir(path.join(testHome, "data", "experts"), { recursive: true });
      await copyTemplateDb(path.join(testHome, "council.db"));
    });

    afterEach(async () => {
      if (originalHome !== undefined) process.env["COUNCIL_HOME"] = originalHome;
      else delete process.env["COUNCIL_HOME"];
      if (originalDataHome !== undefined) process.env["COUNCIL_DATA_HOME"] = originalDataHome;
      else delete process.env["COUNCIL_DATA_HOME"];
      await fs.rm(testHome, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    });

    it("expert delete command accepts --yes flag describing confirmation skip", () => {
      const expertCmd = buildExpertCommand();
      const deleteCmd = expertCmd.commands.find((c) => c.name() === "delete");
      expect(deleteCmd).toBeDefined();
      const yesOpt = deleteCmd?.options.find((o) => o.long === "--yes");
      expect(yesOpt).toBeDefined();
      expect(yesOpt?.description).toContain("confirmation");
    });

    it("--force without --yes rejects in non-interactive mode when expert has panels", async () => {
      // Seed an expert via FileExpertLibrary
      const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const lib = new FileExpertLibrary(path.join(testHome, "data"), db);
        await lib.create({
          slug: "test-expert",
          displayName: "Test Expert",
          role: "A test role",
          expertise: {
            weightedEvidence: ["testing"],
            referenceCases: [],
            notExpertIn: [],
          },
          epistemicStance: "neutral",
          kind: "generic",
        });

        // Add panel membership
        await db
          .insertInto("panel_library")
          .values({
            name: "test-panel",
            yaml_path: path.join(testHome, "data", "panels", "test-panel.yaml"),
            yaml_checksum: "x",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
        await db
          .insertInto("panel_members")
          .values({
            panel_name: "test-panel",
            expert_slug: "test-expert",
            position: 0,
            created_at: new Date().toISOString(),
          })
          .execute();
      } finally {
        await db.destroy();
      }

      // Mock non-interactive environment
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      const expertCmd = buildExpertCommand();
      expertCmd.exitOverride();

      try {
        await expertCmd.parseAsync(["node", "council-expert", "delete", "test-expert", "--force"]);
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        expect(err.message).toContain("--yes");
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // DX-18: --timeout on conclude
  // ─────────────────────────────────────────────────────────────────
  describe("DX-18: --timeout on conclude", () => {
    let testHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-timeout-test-"));
      originalHome = process.env["COUNCIL_HOME"];
      process.env["COUNCIL_HOME"] = testHome;
      await copyTemplateDb(path.join(testHome, "council.db"));
    });

    afterEach(async () => {
      if (originalHome !== undefined) process.env["COUNCIL_HOME"] = originalHome;
      else delete process.env["COUNCIL_HOME"];
      await fs.rm(testHome, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    });

    it("conclude command accepts --timeout with default of SYNTHESIS_TIMEOUT_MS", () => {
      const cmd = buildConcludeCommand();
      const timeoutOpt = cmd.options.find((o) => o.long === "--timeout");
      expect(timeoutOpt).toBeDefined();
      expect(timeoutOpt?.defaultValue).toBe(SYNTHESIS_TIMEOUT_MS);
    });

    it("--timeout rejects non-positive values with specific error", () => {
      const cmd = buildConcludeCommand();
      cmd.exitOverride();
      expect(() => {
        cmd.parse(["node", "conclude", "test-panel", "--timeout", "-1"]);
      }).toThrow(/Invalid timeout value.*must be a positive integer/);
    });

    it("--timeout rejects non-numeric values with specific error", () => {
      const cmd = buildConcludeCommand();
      cmd.exitOverride();
      expect(() => {
        cmd.parse(["node", "conclude", "test-panel", "--timeout", "abc"]);
      }).toThrow(/Invalid timeout value.*must be a positive integer/);
    });

    it("--timeout rejects values exceeding 32-bit signed integer max", () => {
      const cmd = buildConcludeCommand();
      cmd.exitOverride();
      expect(() => {
        cmd.parse(["node", "conclude", "test-panel", "--timeout", "2147483648"]);
      }).toThrow(/Invalid timeout value/);
    });

    it("--timeout value is forwarded to engine synthesis call", async () => {
      const SYNTH_ID = "timeout-test-synth";
      const SAMPLE_JSON = JSON.stringify({
        consensus: ["all agree"],
        tensions: ["none"],
        decisionMatrix: [{ dimension: "Speed", positions: [{ expert: "Dev", stance: "fast" }] }],
        recommendation: "Do it",
        confidence: "high",
      });

      // Seed a panel with turns
      const db = await createDatabase(path.join(testHome, "council.db"));
      const panel = await new PanelRepository(db).create({
        name: "timeout-panel",
        topic: "Timeout test topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "test", mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "dev",
        displayName: "Dev",
        model: "test-model",
        systemMessage: "You are a dev.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Timeout test topic",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: "Dev: we should do it fast.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      await db.destroy();

      const engine = new MockEngine({ responses: { [SYNTH_ID]: SAMPLE_JSON } });

      let stdout = "";
      const cmd = buildConcludeCommand({
        engineFactory: () => engine,
        write: (s) => {
          stdout += s;
        },
        writeError: () => {
          /* suppress stderr in test */
        },
        synthesizerId: SYNTH_ID,
      });
      cmd.exitOverride();

      // With --timeout 5000, the fast mock engine completes well within budget
      await cmd.parseAsync(["node", "conclude", "timeout-panel", "--timeout", "5000"]);
      expect(stdout).toContain("timeout-panel");
    });

    it("--timeout 1 triggers abort when engine is too slow", async () => {
      const SYNTH_ID = "slow-synth";

      // Seed a panel
      const db = await createDatabase(path.join(testHome, "council.db"));
      const panel = await new PanelRepository(db).create({
        name: "slow-panel",
        topic: "Slow topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "test", mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "dev",
        displayName: "Dev",
        model: "test-model",
        systemMessage: "You are a dev.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Slow topic",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: "Dev: thinking slowly...",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      await db.destroy();

      // Create an engine with a deliberate delay to exceed the 1ms timeout
      const engine = new MockEngine({
        responses: { [SYNTH_ID]: "delayed" },
        deltaDelayMs: 500,
      });

      let stderr = "";
      const cmd = buildConcludeCommand({
        engineFactory: () => engine,
        write: () => {
          /* suppress stdout */
        },
        writeError: (s) => {
          stderr += s;
        },
        synthesizerId: SYNTH_ID,
      });
      cmd.exitOverride();

      // --timeout 1 means 1ms — the 500ms delayed engine should trigger an abort
      await expect(
        cmd.parseAsync(["node", "conclude", "slow-panel", "--timeout", "1"]),
      ).rejects.toThrow();
      // The error should mention the timeout
      expect(stderr).toMatch(/aborted|timeout/i);
    });
  });
});

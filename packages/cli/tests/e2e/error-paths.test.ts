import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "commander";

import { buildAskCommand } from "../../src/cli/commands/ask.js";
import { CliUserError } from "../../src/cli/cli-user-error.js";
import { buildConcludeCommand } from "../../src/cli/commands/conclude.js";
import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import { buildExpertCommand } from "../../src/cli/commands/expert.js";
import { buildExportCommand } from "../../src/cli/commands/export.js";
import { buildMemoryCommand } from "../../src/cli/commands/memory.js";
import { buildPanelCommand } from "../../src/cli/commands/panel.js";
import { buildResumeCommand } from "../../src/cli/commands/resume.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";

import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  makeMockEngineFactory,
  openTestDb,
  seedCompletedDebate,
  seedPanelWithExperts,
  type E2EContext,
} from "./helpers.js";

interface CommandFailure {
  readonly error: unknown;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
}

const SYNTHESIZER_ID = "synthesizer-e2e-error-paths";

function prepareCommand(command: Command): Command {
  command.exitOverride();
  return command;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function expectCommandFailure(
  promise: Promise<unknown>,
  output: ReturnType<typeof captureOutput>,
): Promise<CommandFailure> {
  try {
    await promise;
  } catch (error: unknown) {
    return {
      error,
      message: toErrorMessage(error),
      stdout: output.stdout(),
      stderr: output.stderr(),
    };
  }

  throw new Error("Expected command to fail");
}

async function createLibraryExpert(slug: string): Promise<void> {
  const output = captureOutput();
  const command = buildExpertCommand(output.write, output.writeError);

  await command.parseAsync([
    "node",
    "council-expert",
    "create",
    "--slug",
    slug,
    "--name",
    `${slug.toUpperCase()} Expert`,
    "--role",
    `${slug} reviewer`,
    "--expertise",
    "shipped systems",
    "--stance",
    "Empirical",
  ]);
}

async function seedEmptyCompletedDebate(testHome: string, panelName: string): Promise<void> {
  const seeded = await seedPanelWithExperts(testHome, { panelName });
  const db = await openTestDb(testHome);

  try {
    const debateRepo = new DebateRepository(db);
    const debate = await debateRepo.create({
      panelId: seeded.panelId,
      prompt: "No turns were recorded",
      moderator: "round-robin",
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
  } finally {
    await destroyTestDb(db);
  }
}

describe("CLI error paths E2E", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  describe("convene", () => {
    it("resolves engine from config when --engine omitted (no longer required)", async () => {
      await fs.writeFile(path.join(ctx.testHome, "config.yaml"), "defaults:\n  engine: mock\n", "utf-8");
      const output = captureOutput();
      const command = prepareCommand(
        buildConveneCommand({
          engineFactory: makeMockEngineFactory(),
          write: output.write,
          writeError: output.writeError,
        }),
      );

      let thrown = "";
      try {
        await command.parseAsync(["node", "council-convene", "Topic", "--template", "code-review"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).not.toMatch(/--engine.*required|required option.*engine/);
      expect(output.stderr()).toContain("[MOCK ENGINE]");
    });

    it("rejects an unknown template", async () => {
      const output = captureOutput();
      const command = prepareCommand(
        buildConveneCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-convene",
          "Topic",
          "--template",
          "missing-template",
          "--engine",
          "mock",
        ]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/template.*not found|panel template/);
    });
  });

  describe("ask", () => {
    it("rejects an unknown panel", async () => {
      const output = captureOutput();
      const command = prepareCommand(
        buildAskCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-ask",
          "missing-panel",
          "What now?",
          "--engine",
          "mock",
        ]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/no panel|not found/);
    });

    it("rejects an unknown expert slug", async () => {
      const seeded = await seedPanelWithExperts(ctx.testHome, { panelName: "ask-error-panel" });
      const output = captureOutput();
      const command = prepareCommand(
        buildAskCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-ask",
          seeded.panelName,
          "What now?",
          "--expert",
          "ghost",
          "--engine",
          "mock",
        ]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/no expert|not found/);
    });
  });

  describe("resume", () => {
    it("rejects an unknown panel", async () => {
      const output = captureOutput();
      const command = prepareCommand(
        buildResumeCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync(["node", "council-resume", "missing-panel"]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/no.*panel|not.*found|unknown panel/);
    });

    it("resolves engine from config when --prompt is used without --engine", async () => {
      const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "resume-error-panel" });
      const output = captureOutput();
      const command = prepareCommand(
        buildResumeCommand({ write: output.write, writeError: output.writeError }),
      );

      // With engine default feature, --continue without --engine no longer
      // throws. It resolves from config. May fail for other reasons but not
      // because --engine is "required".
      let thrown = "";
      try {
        await command.parseAsync([
          "node",
          "council-resume",
          seeded.panelName,
          "--prompt",
          "What changed?",
        ]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown.toLowerCase()).not.toMatch(/--engine.*required|engine.*required.*continue/);
    });
  });

  describe("export", () => {
    it("rejects an unknown panel", async () => {
      const output = captureOutput();
      const command = prepareCommand(
        buildExportCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync(["node", "council-export", "missing-panel"]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/no panel|not found/);
    });

    it("rejects an unsupported export format", async () => {
      const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "export-error-panel" });
      const output = captureOutput();
      const command = prepareCommand(
        buildExportCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync(["node", "council-export", seeded.panelName, "--format", "yaml"]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/yaml|format.*expected|unknown.*format/);
    });
  });

  describe("conclude", () => {
    it("rejects a completed debate with zero turns", async () => {
      await seedEmptyCompletedDebate(ctx.testHome, "conclude-empty-panel");
      const output = captureOutput();
      const command = prepareCommand(
        buildConcludeCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-conclude",
          "conclude-empty-panel",
          "--engine",
          "mock",
        ]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/no turns|nothing to conclude|empty/);
    });

    it("surfaces engine failures as CliUserError diagnostics", async () => {
      const seeded = await seedCompletedDebate(ctx.testHome, {
        panelName: "conclude-engine-panel",
      });
      const output = captureOutput();
      const command = prepareCommand(
        buildConcludeCommand({
          write: output.write,
          writeError: output.writeError,
          engineFactory: makeMockEngineFactory({
            failures: {
              [SYNTHESIZER_ID]: { code: "INTERNAL", message: "engine blew up" },
            },
          }),
          synthesizerId: SYNTHESIZER_ID,
        }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync(["node", "council-conclude", seeded.panelName, "--engine", "mock"]),
        output,
      );

      expect(failure.error).toBeInstanceOf(CliUserError);
      expect(failure.stderr.toLowerCase()).toMatch(/engine blew up|internal/);
    });
  });

  describe("expert", () => {
    it("reports missing experts via CliUserError", async () => {
      const output = captureOutput();
      const command = prepareCommand(buildExpertCommand(output.write, output.writeError));

      const failure = await expectCommandFailure(
        command.parseAsync(["node", "council-expert", "inspect", "ghost"]),
        output,
      );

      expect(failure.error).toBeInstanceOf(CliUserError);
      expect(failure.message.toLowerCase()).toContain("not found");
      expect(failure.stderr.toLowerCase()).toContain("ghost");
    });

    it("rejects duplicate expert creation", async () => {
      await createLibraryExpert("duplicate-expert");
      const output = captureOutput();
      const command = prepareCommand(buildExpertCommand(output.write, output.writeError));

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-expert",
          "create",
          "--slug",
          "duplicate-expert",
          "--name",
          "Duplicate Expert",
          "--role",
          "Duplicate role",
          "--expertise",
          "evidence",
          "--stance",
          "Empirical",
        ]),
        output,
      );

      expect(failure.error).toBeInstanceOf(CliUserError);
      expect(failure.message.toLowerCase()).toContain("already exists");
      expect(failure.stderr.toLowerCase()).toContain("already exists");
    });
  });

  describe("panel", () => {
    it("rejects unknown expert slugs", async () => {
      const output = captureOutput();
      const command = prepareCommand(buildPanelCommand(output.write, output.writeError));

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-panel",
          "create",
          "review-panel",
          "--experts",
          "ghost",
        ]),
        output,
      );

      expect(failure.error).toBeInstanceOf(CliUserError);
      expect(failure.message.toLowerCase()).toMatch(/unknown expert slug|ghost/);
      expect(failure.stderr.toLowerCase()).toContain("ghost");
    });

    it("rejects unsupported panel modes", async () => {
      await createLibraryExpert("panel-mode-expert");
      const output = captureOutput();
      const command = prepareCommand(buildPanelCommand(output.write, output.writeError));

      const failure = await expectCommandFailure(
        command.parseAsync([
          "node",
          "council-panel",
          "create",
          "mode-panel",
          "--experts",
          "panel-mode-expert",
          "--mode",
          "bogus",
        ]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(
        /unknown.*mode|unsupported.*mode|invalid.*mode/i,
      );
    });
  });

  describe("memory", () => {
    it("refuses destructive reset without --yes and leaves state untouched", async () => {
      const seeded = await seedCompletedDebate(ctx.testHome, { panelName: "memory-error-panel" });
      const output = captureOutput();
      const command = prepareCommand(
        buildMemoryCommand({ write: output.write, writeError: output.writeError }),
      );

      const failure = await expectCommandFailure(
        command.parseAsync(["node", "council-memory", "reset", seeded.panelName]),
        output,
      );

      expect(failure.message.toLowerCase()).toMatch(/--yes|destructive|explicitly/);

      const db = await openTestDb(ctx.testHome);
      try {
        const panel = await new PanelRepository(db).findByName(seeded.panelName);
        expect(panel).not.toBeNull();
        if (!panel) {
          throw new Error("Expected seeded panel to remain after failed reset");
        }
        const experts = await new ExpertRepository(db).findByPanelId(panel.id);
        const debates = await new DebateRepository(db).findByPanelId(panel.id);
        const turns = await new TurnRepository(db).findByDebateId(seeded.debateId);
        expect(experts).toHaveLength(2);
        expect(debates).toHaveLength(1);
        expect(turns).toHaveLength(2);
      } finally {
        await destroyTestDb(db);
      }
    });
  });
});

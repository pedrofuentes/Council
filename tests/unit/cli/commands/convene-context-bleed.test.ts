/**
 * RED — Context bleed regression (T1).
 *
 * Bug: when running `convene` multiple times on the same panel template,
 * Round 2+ of each new debate bleeds content from prior debates because
 * `recallMemory()` injects the prior panel's expert history into the new
 * expert's system prompt at Section [7] MEMORY.
 *
 * Fix: a fresh `convene` invocation must start with a clean slate — no
 * memory recall from any prior panel for the same template. (`resume`
 * still carries forward prior debate history; that path is unaffected.)
 *
 * The post-debate extraction hook (extract-memory-hook) MUST continue to
 * run so memory remains available for `resume`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

describe("convene — no context bleed across sequential debates (T1)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-bleed-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
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

  it("a new convene does NOT inject prior same-template panel content into new expert system prompts", async () => {
    // Seed a prior panel + debate + distinctive turn for `senior` on
    // the `code-review` template. The fix means a fresh `convene`
    // should NOT load this into the new expert's [7] MEMORY section.
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "prior-panel-bleed",
        topic: "old topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", engine: "copilot" }),
      });
      const senior = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "senior",
        displayName: "Senior",
        model: "claude-sonnet-4",
        systemMessage: "(prior)",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "old topic",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 1,
        seq: 1,
        speakerKind: "expert",
        expertId: senior.id,
        content: "BLEED_MARKER_ZULU — prior debate stance about adopting microservices.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "totally unrelated new topic",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    const db2 = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db2).findAll();
      const newPanel = panels.find((p) => p.name !== "prior-panel-bleed");
      expect(newPanel).toBeDefined();
      const experts = await new ExpertRepository(db2).findByPanelId(newPanel?.id ?? "");
      const newSenior = experts.find((e) => e.slug === "senior");
      expect(newSenior).toBeDefined();
      // The new expert's system prompt MUST NOT contain prior-debate marker.
      expect(newSenior?.systemMessage).not.toContain("BLEED_MARKER_ZULU");
      // And MUST NOT contain a populated [7] MEMORY section pulled from
      // the prior panel. (The section header itself may or may not be
      // present depending on prompt-builder rendering of empty memory;
      // what matters is no prior content leaks.)
      expect(newSenior?.systemMessage).not.toContain("microservices");
    } finally {
      await db2.destroy();
    }
  });
});

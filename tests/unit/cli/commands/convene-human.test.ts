/**
 * Tests for `--human` flag on convene command (ROADMAP §3.3).
 *
 * RED at this commit: convene does not accept --human.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

describe("convene --human", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-human-test-"));
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

  it("--human adds a human participant to the panel with model='human'", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new MockEngine({ responses: {} }),
      write: () => undefined,
      writeError: () => undefined,
      humanInputFactory: () => ({
        async getInput() {
          return { kind: "submitted" as const, content: "I agree with shipping." };
        },
      }),
    });

    await cmd.parseAsync([
      "node", "council-convene", "Should we ship?",
      "--template", "code-review",
      "--engine", "mock",
      "--human", "Product Lead",
      "--max-rounds", "1",
    ]);

    // Verify DB has the human expert
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels).toHaveLength(1);
      const panelId = panels[0]?.id ?? "";
      const experts = await new ExpertRepository(db).findByPanelId(panelId);
      const humanExpert = experts.find((e) => e.model === "human");
      expect(humanExpert).toBeDefined();
      expect(humanExpert?.displayName).toBe("Product Lead");
      expect(humanExpert?.slug).toBe("product-lead");

      // Verify the human's turn is persisted with speakerKind = "human"
      const debates = await new DebateRepository(db).findByPanelId(panelId);
      expect(debates).toHaveLength(1);
      const debateId = debates[0]?.id ?? "";
      const turns = await new TurnRepository(db).findByDebateId(debateId);
      const humanTurns = turns.filter((t) => t.expertId === humanExpert?.id);
      expect(humanTurns.length).toBeGreaterThanOrEqual(1);
      expect(humanTurns[0]?.speakerKind).toBe("human");
    } finally {
      await db.destroy();
    }
  });

  it("multiple --human flags add multiple human participants", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new MockEngine({ responses: {} }),
      write: () => undefined,
      writeError: () => undefined,
      humanInputFactory: () => ({
        async getInput() {
          return { kind: "submitted" as const, content: "Agreed." };
        },
      }),
    });

    await cmd.parseAsync([
      "node", "council-convene", "Topic",
      "--template", "code-review",
      "--engine", "mock",
      "--human", "Alice",
      "--human", "Bob",
      "--max-rounds", "1",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const panelId = panels[0]?.id ?? "";
      const experts = await new ExpertRepository(db).findByPanelId(panelId);
      const humans = experts.filter((e) => e.model === "human");
      expect(humans).toHaveLength(2);
      expect(humans.map((h) => h.displayName).sort()).toEqual(["Alice", "Bob"]);
    } finally {
      await db.destroy();
    }
  });
});

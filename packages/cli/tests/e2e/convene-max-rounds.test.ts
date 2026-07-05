/**
 * RED — the classic CLI convene path must honor a panel template's declared
 * `maxRounds`, matching the TUI convene path
 * (`tui/adapters/convene-resolve.ts`) and what `templates inspect` reports.
 *
 * Regression: `convene --panel code-review` (template declares `maxRounds: 3`)
 * used to run 4 rounds via the CLI (a hardcoded default) while the TUI ran 3.
 * These tests pin the precedence flag > template default > config default.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as yaml from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import type { ExpertDefinition } from "../../src/core/expert.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";
import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  makeMockEngineFactory,
  openTestDb,
  type E2EContext,
} from "./helpers.js";

const TOPIC = "Should we ship the MVP?";

type CapturedOutput = ReturnType<typeof captureOutput>;

async function runConvene(
  args: readonly string[],
  engineFactory: () => CouncilEngine = makeMockEngineFactory(),
): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildConveneCommand({
    engineFactory,
    write: output.write,
    writeError: output.writeError,
  });
  await cmd.parseAsync(["node", "council-convene", ...args]);
  return output;
}

/**
 * Count the distinct rounds actually executed by the most-recent persisted
 * debate. Each freeform round-robin round emits one expert turn per expert, so
 * the number of distinct `round` values across expert turns equals the number
 * of rounds the debate ran.
 */
async function countDebateRounds(ctx: E2EContext): Promise<number> {
  const db = await openTestDb(ctx.testHome);
  try {
    const panel = (await new PanelRepository(db).findAll()).at(-1);
    if (!panel) {
      throw new Error("Expected a persisted panel.");
    }
    const debate = (await new DebateRepository(db).findByPanelId(panel.id)).at(-1);
    if (!debate) {
      throw new Error("Expected a persisted debate.");
    }
    const turns = await new TurnRepository(db).findByDebateId(debate.id);
    const expertRounds = turns
      .filter((turn) => turn.speakerKind === "expert")
      .map((turn) => turn.round);
    return new Set(expertRounds).size;
  } finally {
    await destroyTestDb(db);
  }
}

function inlineExpert(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `${slug} Expert`,
    role: `${slug} role`,
    expertise: {
      weightedEvidence: [`${slug} evidence`],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: `${slug} stance`,
    kind: "generic",
  };
}

/**
 * Write a user panel YAML (with inline experts) that declares NO
 * `defaults.maxRounds`, so convene must fall back to the config default.
 */
async function seedPanelWithoutMaxRounds(ctx: E2EContext, name: string): Promise<void> {
  const panelDefinition = {
    name,
    description: `${name} panel`,
    defaults: { mode: "freeform" },
    experts: [inlineExpert("alpha"), inlineExpert("beta")],
  };
  await fs.writeFile(
    path.join(ctx.testDataHome, "panels", `${name}.yaml`),
    yaml.stringify(panelDefinition),
    "utf-8",
  );
}

describe("convene CLI — honors template maxRounds", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  it("runs the template's declared maxRounds (code-review → 3), not the old hardcoded 4", async () => {
    const output = await runConvene([
      TOPIC,
      "--panel",
      "code-review",
      "--engine",
      "mock",
      "--no-conclude",
      "--format",
      "plain",
    ]);

    expect(await countDebateRounds(ctx)).toBe(3);
    expect(output.stdout()).toContain("Max rounds: 3");
  });

  it("lets an explicit --max-rounds flag override the template default", async () => {
    const output = await runConvene([
      TOPIC,
      "--panel",
      "code-review",
      "--max-rounds",
      "2",
      "--engine",
      "mock",
      "--no-conclude",
      "--format",
      "plain",
    ]);

    expect(await countDebateRounds(ctx)).toBe(2);
    expect(output.stdout()).toContain("Max rounds: 2");
  });

  it("falls back to the config default when the template declares no maxRounds", async () => {
    // Distinctive config value (6) proves the fallback targets config.defaults,
    // not a hardcoded convene constant (which was 4).
    await fs.writeFile(
      path.join(ctx.testHome, "config.yaml"),
      "defaults:\n  maxRounds: 6\n",
      "utf-8",
    );
    await seedPanelWithoutMaxRounds(ctx, "no-rounds-panel");

    const output = await runConvene([
      TOPIC,
      "--panel",
      "no-rounds-panel",
      "--engine",
      "mock",
      "--no-conclude",
      "--format",
      "plain",
    ]);

    expect(await countDebateRounds(ctx)).toBe(6);
    expect(output.stdout()).toContain("Max rounds: 6");
  });
});

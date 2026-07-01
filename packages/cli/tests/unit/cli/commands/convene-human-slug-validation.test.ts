/**
 * Validation for the slug derived from a `--human <name>` participant (#207).
 *
 * A human's slug is `slugify(displayName)`. Two failure modes were previously
 * unguarded:
 *   1. Empty slug — a punctuation/emoji-only name (e.g. "!!!") slugifies to "",
 *      producing an unaddressable participant.
 *   2. Collision — the slug can duplicate an AI expert already on the panel, or
 *      another `--human`. The `experts` table is UNIQUE(panel_id, slug), so a
 *      duplicate silently breaks turn attribution and the debate's identity map.
 *
 * convene must fail fast on both, BEFORE persisting a panel or launching the
 * debate, with an actionable message.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import type { HumanInputProvider } from "../../../../src/core/human-input.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

function makeHumanInputFactory(): () => HumanInputProvider {
  return () => ({
    async getInput() {
      return { kind: "submitted" as const, content: "Agreed." };
    },
  });
}

describe("convene --human slug validation (#207)", () => {
  let testHome: string;
  let testDataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-human-slug-home-"));
    testDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-human-slug-data-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testDataHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    for (const dir of [testHome, testDataHome]) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    }
  });

  async function persistedPanelCount(): Promise<number> {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      return (await new PanelRepository(db).findAll()).length;
    } finally {
      await db.destroy();
    }
  }

  it("rejects a --human name that slugifies to an empty string", async () => {
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      humanInputFactory: makeHumanInputFactory(),
      write: () => undefined,
      writeError: (s: string) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    // slugify("!!!") === "" — no letters or digits survive.
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Should we ship?",
        "--template",
        "code-review",
        "--engine",
        "mock",
        "--human",
        "!!!",
        "--max-rounds",
        "1",
      ]),
    ).rejects.toThrow(/--human/i);

    expect(stderr).toMatch(/--human/i);
    expect(stderr).toMatch(/slug/i);
    expect(stderr).toMatch(/letter|digit|number/i);
    // Fail fast: nothing is persisted for a rejected run.
    expect(await persistedPanelCount()).toBe(0);
  });

  it("rejects a --human name whose slug collides with an AI expert on the panel", async () => {
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      humanInputFactory: makeHumanInputFactory(),
      write: () => undefined,
      writeError: (s: string) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    // The built-in `code-review` panel has an expert with slug "senior";
    // slugify("Senior") === "senior", colliding with it.
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Should we ship?",
        "--template",
        "code-review",
        "--engine",
        "mock",
        "--human",
        "Senior",
        "--max-rounds",
        "1",
      ]),
    ).rejects.toThrow(/--human/i);

    expect(stderr).toMatch(/--human/i);
    expect(stderr).toContain("senior");
    expect(stderr).toMatch(/collide|already|conflict|distinct/i);
    // Fail fast: the panel is never persisted.
    expect(await persistedPanelCount()).toBe(0);
  });

  it("rejects two --human names that slugify to the same slug", async () => {
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      humanInputFactory: makeHumanInputFactory(),
      write: () => undefined,
      writeError: (s: string) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    // Both names slugify to "casey-jones" — a self-collision among humans.
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Should we ship?",
        "--template",
        "code-review",
        "--engine",
        "mock",
        "--human",
        "Casey Jones",
        "--human",
        "casey-jones",
        "--max-rounds",
        "1",
      ]),
    ).rejects.toThrow(/--human/i);

    expect(stderr).toMatch(/--human/i);
    expect(stderr).toContain("casey-jones");
    expect(await persistedPanelCount()).toBe(0);
  });
});

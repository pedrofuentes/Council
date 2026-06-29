/**
 * RED — runWithEngine must NOT conflate persistence/render errors with
 * engine errors (#195). The single try/catch around engine init +
 * persist + render maps every thrown error through `formatEngineError`,
 * so a DB write failure surfaces the generic "Engine error." hint —
 * misleading the user. Persist/render failures must be reported with
 * their raw message, while genuine engine-init failures keep their
 * actionable engine hint.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyTemplateDb } from "../../helpers/template-db.js";
import { runWithEngine } from "../../../src/cli/run-with-engine.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { DebatePersister } from "../../../src/memory/persister.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";

const expert: ExpertSpec = {
  id: "placeholder",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

describe("runWithEngine — engine vs persistence/render error scoping (#195)", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelId: string;
  let expertSlugToId: Record<string, string>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-errscope-"));
    await copyTemplateDb(path.join(dir, "council.db"));
    db = await createDatabase(path.join(dir, "council.db"));
    const panel = await new PanelRepository(db).create({
      name: "p",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;
    const e = await new ExpertRepository(db).create({
      panelId,
      slug: expert.slug,
      displayName: expert.displayName,
      model: expert.model,
      systemMessage: expert.systemMessage,
    });
    expertSlugToId = { [expert.slug]: e.id };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("does NOT map a persistence error through formatEngineError", async () => {
    vi.spyOn(DebatePersister.prototype, "persist").mockImplementation(
      function (this: DebatePersister): AsyncIterable<DebateEvent> {
        return (async function* (): AsyncGenerator<DebateEvent, void, void> {
          yield { kind: "panel.assembled", experts: [] };
          throw new Error("SQLITE_BUSY: database is locked");
        })();
      },
    );

    let errOutput = "";
    await expect(
      runWithEngine({
        engineKind: "mock",
        engineFactory: () => new MockEngine(),
        experts: [{ ...expert, id: expertSlugToId[expert.slug] ?? "" }],
        debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
        prompt: "Topic",
        panelId,
        expertSlugToId,
        moderator: "round-robin",
        format: "json",
        write: () => undefined,
        writeError: (s: string) => {
          errOutput += s;
        },
        db,
      }),
    ).rejects.toThrow(/SQLITE_BUSY/);

    // Underlying message is surfaced, but NOT wrapped as a generic engine hint.
    expect(errOutput).toContain("SQLITE_BUSY");
    expect(errOutput).not.toContain("Engine error.");
  });

  it("still maps a genuine engine-init failure through formatEngineError", async () => {
    let errOutput = "";
    await expect(
      runWithEngine({
        engineKind: "mock",
        engineFactory: () => ({
          start: async () => {
            throw new Error("engine init failed");
          },
          stop: async () => undefined,
          addExpert: async () => undefined,
          removeExpert: async () => undefined,
          listModels: async () => [],
          send: () => {
            throw new Error("nope");
          },
        }),
        experts: [{ ...expert, id: expertSlugToId[expert.slug] ?? "" }],
        debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
        prompt: "Topic",
        panelId,
        expertSlugToId,
        moderator: "round-robin",
        format: "plain",
        write: () => undefined,
        writeError: (s: string) => {
          errOutput += s;
        },
        db,
      }),
    ).rejects.toThrow("engine init failed");

    expect(errOutput).toContain("Underlying:");
    expect(errOutput).toContain("engine init failed");
  });
});

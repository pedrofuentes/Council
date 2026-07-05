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
    vi.spyOn(DebatePersister.prototype, "persist").mockImplementation(function (
      this: DebatePersister,
    ): AsyncIterable<DebateEvent> {
      return (async function* (): AsyncGenerator<DebateEvent, void, void> {
        yield { kind: "panel.assembled", experts: [] };
        throw new Error("SQLITE_BUSY: database is locked");
      })();
    });

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

  describe("Error.cause propagation & construction-in-try (#153, #1378)", () => {
    it("attaches the first expert-registration failure as Error.cause (#153)", async () => {
      const registrationError = new Error("addExpert rejected: quota exceeded");
      const engine = new MockEngine();
      vi.spyOn(engine, "addExpert").mockRejectedValue(registrationError);

      let caught: unknown;
      try {
        await runWithEngine({
          engineKind: "mock",
          engineFactory: () => engine,
          experts: [{ ...expert, id: expertSlugToId[expert.slug] ?? "" }],
          debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
          prompt: "Topic",
          panelId,
          expertSlugToId,
          moderator: "round-robin",
          format: "plain",
          write: () => undefined,
          writeError: () => undefined,
          db,
        });
      } catch (e: unknown) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/could not register all experts/);
      // The aggregate error must expose the first underlying rejection via
      // `cause` so downstream handlers can introspect it (#153).
      expect((caught as Error).cause).toBe(registrationError);
    });

    it("routes a synchronous engine-construction failure through formatEngineError (#1378)", async () => {
      const constructionError = new Error("provider is not yet available");

      let errOutput = "";
      await expect(
        runWithEngine({
          engineKind: "mock",
          engineFactory: () => {
            throw constructionError;
          },
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
      ).rejects.toThrow("provider is not yet available");

      // Construction now happens inside the try, so a synchronous throw gets
      // the same actionable formatEngineError treatment as start()/registration
      // failures instead of bypassing it (#1378).
      expect(errOutput).toContain("Underlying:");
      expect(errOutput).toContain("provider is not yet available");
    });
  });

  it("rolls back only the fulfilled subset and writes formatEngineError to stderr on partial addExpert failure (#201)", async () => {
    // The existing error-scope tests fail addExpert for the ONLY expert,
    // so the fulfilled subset is empty and the removeExpert rollback loop
    // (run-with-engine.ts ~L194-219) never runs. `failOnAddExpert.afterN: 1`
    // makes the FIRST addExpert fulfill and the rest reject, producing a
    // NON-empty fulfilled subset — exercising the rollback for exactly the
    // experts that genuinely registered, not the whole intended list.
    const engine = new MockEngine({ failOnAddExpert: { afterN: 1 } });

    const experts: ExpertSpec[] = [
      {
        id: "e0-fulfilled",
        slug: "cto",
        displayName: "CTO",
        model: "mock-model",
        systemMessage: "You are a CTO.",
      },
      {
        id: "e1-rejected",
        slug: "cfo",
        displayName: "CFO",
        model: "mock-model",
        systemMessage: "You are a CFO.",
      },
      {
        id: "e2-rejected",
        slug: "eng",
        displayName: "Eng",
        model: "mock-model",
        systemMessage: "You are an engineer.",
      },
    ];

    let errOutput = "";
    await expect(
      runWithEngine({
        engineKind: "mock",
        engineFactory: () => engine,
        experts,
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
    ).rejects.toThrow(/could not register all experts/);

    // Rollback removed EXACTLY the fulfilled expert (e0) — never the two
    // that failed to register (e1, e2). A regression that swept the whole
    // intended list, or skipped rollback entirely, changes this array.
    expect(engine.removeExpertCalls).toEqual(["e0-fulfilled"]);

    // The engine-init failure is routed through formatEngineError before
    // re-throw: its always-present "Underlying:" label plus the aggregate
    // registration message land on stderr. Dropping the formatEngineError
    // write would remove "Underlying:" from stderr, failing this.
    expect(errOutput).toContain("Underlying:");
    expect(errOutput).toContain("could not register all experts");
  });
});

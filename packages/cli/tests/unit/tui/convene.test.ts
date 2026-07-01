import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import type { DebateConfig } from "../../../src/core/debate.js";
import type { DebateEndReason } from "../../../src/core/types.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import {
  createConveneSource,
  type ConveneDataSource,
  type ConveneDeps,
  type ConveneViewEvent,
} from "../../../src/tui/adapters/convene.js";
import { copyTemplateDb } from "../../helpers/template-db.js";
import { ScriptedEngine } from "../../helpers/scripted-engine.js";

const cto: ExpertSpec = {
  id: "expert-cto",
  slug: "cto",
  displayName: "CTO\n\u001B[31mInjected",
  model: "scripted",
  systemMessage: "You are the CTO.",
};

const pm: ExpertSpec = {
  id: "expert-pm",
  slug: "pm",
  displayName: "PM",
  model: "scripted",
  systemMessage: "You are the PM.",
};

const freeformConfig: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [],
};

// A message that combines every terminal-injection vector called out in #1663:
// an ANSI CSI sequence, a raw C1 CSI (U+009B), CR/LF, the Unicode line and
// paragraph separators (U+2028/U+2029), a TAB, a bidi override (U+202E), a bidi
// isolate (U+2066) and a zero-width space. A single-line sink must collapse or
// strip all of these.
const ADVERSARIAL_MESSAGE =
  "boom\u001B[31mANSI\u009BC1\rCR\nLF\u2028LS\u2029PS\tTAB\u202Ebidi\u2066iso\u200Bzw done";

// C0/C1 controls, DEL, the Unicode line/paragraph separators and the bidi
// override/isolate ranges — none may survive on a single-line terminal surface.
const TERMINAL_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

interface ResolvedPanel {
  readonly experts: readonly ExpertSpec[];
  readonly debateConfig: DebateConfig;
  readonly panelId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
  readonly moderator: string;
  readonly mode: "freeform" | "structured";
  readonly phaseCount: number;
}

class TrackingScriptedEngine extends ScriptedEngine {
  stopCount = 0;

  override async stop(): Promise<void> {
    this.stopCount += 1;
    await super.stop();
  }
}

class FailingAddExpertEngine extends TrackingScriptedEngine {
  readonly removedExpertIds: string[] = [];

  override async addExpert(spec: ExpertSpec): Promise<void> {
    if (spec.id === pm.id) {
      throw new Error("cannot add PM");
    }
    await super.addExpert(spec);
  }

  override async removeExpert(expertId: string): Promise<void> {
    this.removedExpertIds.push(expertId);
    await super.removeExpert(expertId);
  }
}

class StringFailingAddExpertEngine extends TrackingScriptedEngine {
  override async addExpert(spec: ExpertSpec): Promise<void> {
    if (spec.id === pm.id) {
      throw "string failure";
    }
    await super.addExpert(spec);
  }
}

class AdversarialFailingAddExpertEngine extends TrackingScriptedEngine {
  override async addExpert(spec: ExpertSpec): Promise<void> {
    if (spec.id === pm.id) {
      throw new Error(ADVERSARIAL_MESSAGE);
    }
    await super.addExpert(spec);
  }
}

class StopRejectingEngine extends TrackingScriptedEngine {
  override async stop(): Promise<void> {
    this.stopCount += 1;
    throw new Error("stop failed");
  }
}

class AbortAfterDeltaEngine implements CouncilEngine {
  stopCount = 0;
  readonly sends: SendOptions[] = [];
  readonly #controller: AbortController;
  readonly #experts = new Set<string>();

  constructor(controller: AbortController) {
    this.#controller = controller;
  }

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.add(spec.id);
  }

  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }

  async listModels(): Promise<readonly string[]> {
    return ["scripted"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push(options);
    const controller = this.#controller;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        yield { kind: "message.delta", expertId: options.expertId, text: "partial \u001B[31mtext" };
        controller.abort();
        yield {
          kind: "error",
          expertId: options.expertId,
          error: { code: "ABORTED", message: "aborted" },
          recoverable: false,
        };
      },
    };
  }
}

async function makeDatabase(): Promise<{ readonly db: CouncilDatabase; readonly dir: string }> {
  const root = path.join(process.cwd(), ".tmp-convene-test-");
  const dir = await fs.mkdtemp(root);
  const dbPath = path.join(dir, "council.db");
  await copyTemplateDb(dbPath);
  const db = await createDatabase(dbPath);
  await seedPanel(db);
  return { db, dir };
}

async function seedPanel(db: CouncilDatabase): Promise<void> {
  await db
    .insertInto("panels")
    .values({
      id: "panel-1",
      name: "launch-panel",
      topic: "Launch",
      copilot_home: ".council",
      config_json: "{}",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();

  for (const expert of [cto, pm]) {
    await db
      .insertInto("experts")
      .values({
        id: expert.id,
        panel_id: "panel-1",
        slug: expert.slug,
        display_name: expert.displayName,
        model: expert.model,
        system_message: expert.systemMessage,
        copilot_session_id: null,
        created_at: new Date().toISOString(),
        extracted_memory_json: null,
        memory_source_debate_id: null,
        memory_derivation: null,
        memory_trust_score: null,
        memory_extracted_at: null,
      })
      .execute();
  }
}

function resolvedPanel(overrides: Partial<ResolvedPanel> = {}): ResolvedPanel {
  return {
    experts: [cto, pm],
    debateConfig: freeformConfig,
    panelId: "panel-1",
    expertSlugToId: { cto: cto.id, pm: pm.id },
    moderator: "round-robin",
    mode: "freeform",
    phaseCount: 4,
    ...overrides,
  };
}

function makeSource(
  db: CouncilDatabase,
  engine: CouncilEngine,
  panel: ResolvedPanel = resolvedPanel(),
): ConveneDataSource {
  const deps: ConveneDeps = {
    db,
    engineFactory: () => engine,
    resolvePanel: async (panelName: string): Promise<ResolvedPanel> => {
      if (panelName === "missing") throw new Error("panel not found");
      return panel;
    },
  };
  return createConveneSource(deps);
}

describe("createConveneSource", () => {
  let db: CouncilDatabase;
  let dir: string;

  beforeEach(async () => {
    const created = await makeDatabase();
    db = created.db;
    dir = created.dir;
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("estimates freeform debate cost from expert count and max rounds", async () => {
    const source = makeSource(
      db,
      new TrackingScriptedEngine({ scripts: {} }),
      resolvedPanel({ debateConfig: { ...freeformConfig, maxRounds: 3 } }),
    );

    await expect(source.estimateCost("launch-panel")).resolves.toEqual({
      experts: 2,
      rounds: 3,
      estimatedPremiumRequests: 6,
    });
  });

  it("estimates structured debate cost from expert count and phase count", async () => {
    const source = makeSource(
      db,
      new TrackingScriptedEngine({ scripts: {} }),
      resolvedPanel({
        debateConfig: { ...freeformConfig, mode: "structured", maxRounds: 9 },
        mode: "structured",
        phaseCount: 4,
      }),
    );

    await expect(source.estimateCost("launch-panel")).resolves.toEqual({
      experts: 2,
      rounds: 9,
      estimatedPremiumRequests: 8,
    });
  });

  it("propagates panel resolution failures while estimating", async () => {
    const source = makeSource(db, new TrackingScriptedEngine({ scripts: {} }));

    await expect(source.estimateCost("missing")).rejects.toThrow("panel not found");
  });

  it("streams a debate through the persister and emits sanitized view events in order", async () => {
    const engine = new TrackingScriptedEngine({
      scripts: {
        [cto.id]: [{ kind: "content", text: "CTO says\nhello \u001B[31mred" }],
        [pm.id]: [
          {
            kind: "content",
            text: "PM counters with more than twelve words so the quality gate passes cleanly.",
          },
        ],
      },
    });
    const source = makeSource(db, engine);
    const events: ConveneViewEvent[] = [];

    const result = await source.streamDebate("launch-panel", "Ship it?", {}, (event) => {
      events.push(event);
    });

    expect(result.reason).toBe("completed");
    expect(result.debateId).toEqual(expect.any(String));
    expect(events).toEqual([
      { kind: "panel", experts: ["CTO Injected", "PM"] },
      { kind: "round", round: 0 },
      { kind: "turn-start", expert: "CTO Injected", round: 0 },
      { kind: "turn-delta", expert: "CTO Injected", text: "CTO says\nhello red" },
      { kind: "turn-end", expert: "CTO Injected" },
      { kind: "cost", premiumRequests: 1, estimatedTotal: 2 },
      { kind: "turn-start", expert: "PM", round: 0 },
      {
        kind: "turn-delta",
        expert: "PM",
        text: "PM counters with more than twelve words so the quality gate passes cleanly.",
      },
      { kind: "turn-end", expert: "PM" },
      { kind: "cost", premiumRequests: 2, estimatedTotal: 2 },
      { kind: "end", reason: "completed" },
    ]);
    expect(engine.stopCount).toBe(1);

    const turns = await new TurnRepository(db).findByDebateId(result.debateId ?? "");
    expect(turns.map((turn) => turn.content)).toEqual([
      "CTO says\nhello \u001B[31mred",
      "PM counters with more than twelve words so the quality gate passes cleanly.",
    ]);
  });

  it("preserves the debate result even when engine.stop() rejects", async () => {
    const engine = new StopRejectingEngine({
      scripts: {
        [cto.id]: [{ kind: "content", text: "CTO ships it." }],
        [pm.id]: [
          {
            kind: "content",
            text: "PM counters with more than twelve words so the quality gate passes cleanly.",
          },
        ],
      },
    });
    const source = makeSource(db, engine);

    const result = await source.streamDebate("launch-panel", "Ship it?", {}, () => undefined);

    expect(result.reason).toBe("completed");
    expect(result.debateId).toEqual(expect.any(String));
    expect(engine.stopCount).toBe(1);
  });

  it("returns aborted and persists a partial turn when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const engine = new AbortAfterDeltaEngine(controller);
    const source = makeSource(db, engine);
    const events: ConveneViewEvent[] = [];

    const result = await source.streamDebate(
      "launch-panel",
      "Stop halfway",
      { signal: controller.signal },
      (event) => {
        events.push(event);
      },
    );

    expect(result.reason).toBe("aborted");
    expect(events).toContainEqual({
      kind: "turn-delta",
      expert: "CTO Injected",
      text: "partial text",
    });
    expect(events.at(-1)).toEqual({ kind: "end", reason: "aborted" });
    expect(engine.stopCount).toBe(1);

    const debate = await new DebateRepository(db).findById(result.debateId ?? "");
    expect(debate?.status).toBe("interrupted");
    const turns = await new TurnRepository(db).findByDebateId(result.debateId ?? "");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toBe("partial \u001B[31mtext");
  });

  it("maps scripted engine errors to sanitized error view events", async () => {
    const engine = new TrackingScriptedEngine({
      scripts: {
        [cto.id]: [
          {
            kind: "error",
            code: "PROVIDER_ERROR",
            message: "bad \u001B[31merror",
            recoverable: false,
          },
        ],
        [pm.id]: [{ kind: "content", text: "PM continues after the error." }],
      },
    });
    const source = makeSource(db, engine);
    const events: ConveneViewEvent[] = [];

    const result = await source.streamDebate("launch-panel", "Handle errors", {}, (event) => {
      events.push(event);
    });

    expect(result.reason).toBe("completed");
    expect(events).toContainEqual({ kind: "error", message: "bad error" });
    expect(engine.stopCount).toBe(1);
  });

  it("collapses adversarial control bytes in mapped error view events onto a single line", async () => {
    const engine = new TrackingScriptedEngine({
      scripts: {
        [cto.id]: [
          {
            kind: "error",
            code: "PROVIDER_ERROR",
            message: ADVERSARIAL_MESSAGE,
            recoverable: false,
          },
        ],
        [pm.id]: [{ kind: "content", text: "PM continues after the error." }],
      },
    });
    const source = makeSource(db, engine);
    const events: ConveneViewEvent[] = [];

    await source.streamDebate("launch-panel", "Handle errors", {}, (event) => {
      events.push(event);
    });

    const errorEvents = events.filter(
      (event): event is Extract<ConveneViewEvent, { kind: "error" }> => event.kind === "error",
    );
    expect(errorEvents).toHaveLength(1);
    const message = errorEvents[0]?.message ?? "";
    // Visible content survives, but the surface is single-line and control-free.
    expect(message).toContain("boom");
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
  });

  it("removes already-registered experts and stops the engine when registration fails", async () => {
    const engine = new FailingAddExpertEngine({ scripts: {} });
    const source = makeSource(db, engine);

    await expect(
      source.streamDebate("launch-panel", "Register experts", {}, () => undefined),
    ).rejects.toThrow("could not register all experts (1/2 failed): cannot add PM");

    expect(engine.removedExpertIds).toEqual([cto.id]);
    expect(engine.stopCount).toBe(1);
  });

  it("reports non-Error expert registration failures without wrapping them as sanitized view events", async () => {
    const engine = new StringFailingAddExpertEngine({ scripts: {} });
    const source = makeSource(db, engine);

    await expect(
      source.streamDebate("launch-panel", "Register experts", {}, () => undefined),
    ).rejects.toThrow("could not register all experts (1/2 failed): string failure");

    expect(engine.stopCount).toBe(1);
  });

  it("sanitizes adversarial control bytes in the registration-failure throw onto a single line", async () => {
    const engine = new AdversarialFailingAddExpertEngine({ scripts: {} });
    const source = makeSource(db, engine);

    let caught: unknown;
    try {
      await source.streamDebate("launch-panel", "Register experts", {}, () => undefined);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("could not register all experts (1/2 failed):");
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
    expect(engine.stopCount).toBe(1);
  });

  it("ignores retry, quality-gate, and round-end debate events without dropping terminal reason", async () => {
    const engine = new TrackingScriptedEngine({
      scripts: {
        [cto.id]: [
          { kind: "content", text: "" },
          { kind: "content", text: "short" },
        ],
        [pm.id]: [
          {
            kind: "content",
            text: "PM has a sufficiently long counter about missing risk and launch sequencing.",
          },
        ],
      },
    });
    const source = makeSource(
      db,
      engine,
      resolvedPanel({
        debateConfig: {
          ...freeformConfig,
          qualityGate: { mode: "warn", maxRegenerations: 0 },
        },
      }),
    );
    const events: ConveneViewEvent[] = [];

    const result = await source.streamDebate("launch-panel", "Retry then warn", {}, (event) => {
      events.push(event);
    });

    expect(result.reason satisfies DebateEndReason).toBe("completed");
    expect(events.filter((event) => event.kind === "turn-delta")).toEqual([
      { kind: "turn-delta", expert: "CTO Injected", text: "short" },
      {
        kind: "turn-delta",
        expert: "PM",
        text: "PM has a sufficiently long counter about missing risk and launch sequencing.",
      },
    ]);
    expect(events.at(-1)).toEqual({ kind: "end", reason: "completed" });
  });
});

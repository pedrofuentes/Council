import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";
import { loadTranscript, type TranscriptDocument } from "../../../src/memory/transcript.js";
import {
  createConcludeSource,
  type ConcludeDeps,
  type ConclusionView,
} from "../../../src/tui/adapters/conclude.js";
import { copyTemplateDb } from "../../helpers/template-db.js";

/** Asserts a rendered field carries none of the row-spoofing control chars. */
function expectSingleLine(value: string | undefined): void {
  expect(value).toBeTypeOf("string");
  for (const forbidden of ["\u0007", "\r", "\n", "\u2028", "\u2029"]) {
    expect(value).not.toContain(forbidden);
  }
}

/** The deterministic JSON the synthesizer emits for a clean run. */
const VALID_SYNTH_JSON = JSON.stringify({
  consensus: ["Both experts agree the coupling is painful"],
  tensions: ["Timing of the migration is contested"],
  decisionMatrix: [
    {
      dimension: "Risk",
      positions: [
        { expert: "CTO", stance: "High operational risk" },
        { expert: "PM", stance: "Medium velocity risk" },
      ],
    },
  ],
  recommendation: "Start a phased migration behind a feature flag.",
  confidence: "medium",
});

/**
 * Minimal CouncilEngine that streams a single, caller-supplied JSON blob for
 * any send and records how many times it was stopped. Lets each test pin the
 * exact synthesizer output (valid, malicious, or unparseable) and assert the
 * engine is always stopped in a finally.
 */
class ScriptedSynthEngine implements CouncilEngine {
  stopCount = 0;
  readonly #json: string;
  readonly #stopRejects: boolean;
  readonly #experts = new Set<string>();

  constructor(json: string, options: { readonly stopRejects?: boolean } = {}) {
    this.#json = json;
    this.#stopRejects = options.stopRejects ?? false;
  }

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (this.#stopRejects) {
      throw new Error("stop failed");
    }
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.add(spec.id);
  }

  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }

  async listModels(): Promise<readonly string[]> {
    return ["mock-model"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    const json = this.#json;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        yield { kind: "message.delta", expertId: options.expertId, text: json };
      },
    };
  }
}

/** MockEngine that records its stop count for finally-cleanup assertions. */
class TrackingMockEngine extends MockEngine {
  stopCount = 0;

  override async stop(): Promise<void> {
    this.stopCount += 1;
    await super.stop();
  }
}

async function makeDatabase(): Promise<{ readonly db: CouncilDatabase; readonly dir: string }> {
  const root = path.join(process.cwd(), ".tmp-conclude-test-");
  const dir = await fs.mkdtemp(root);
  const dbPath = path.join(dir, "council.db");
  await copyTemplateDb(dbPath);
  const db = await createDatabase(dbPath);
  return { db, dir };
}

interface SeedOptions {
  readonly name?: string;
  readonly completed?: boolean;
}

async function seedDebate(
  db: CouncilDatabase,
  options: SeedOptions = {},
): Promise<{ readonly panelName: string }> {
  const name = options.name ?? "migrate-panel";
  const panel = await new PanelRepository(db).create({
    name,
    topic: "Should we migrate to microservices?",
    copilotHome: ".council",
    configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
  });
  const cto = await new ExpertRepository(db).create({
    panelId: panel.id,
    slug: "cto",
    displayName: "CTO",
    model: "mock-model",
    systemMessage: "You are a CTO.",
  });
  const pm = await new ExpertRepository(db).create({
    panelId: panel.id,
    slug: "pm",
    displayName: "PM",
    model: "mock-model",
    systemMessage: "You are a PM.",
  });
  const debate = await new DebateRepository(db).create({
    panelId: panel.id,
    prompt: "Should we migrate to microservices?",
    moderator: "round-robin",
  });
  await new TurnRepository(db).create({
    debateId: debate.id,
    round: 0,
    seq: 0,
    speakerKind: "expert",
    expertId: cto.id,
    content: "CTO: the monolith's coupling is a real problem; we should split.",
  });
  await new TurnRepository(db).create({
    debateId: debate.id,
    round: 0,
    seq: 1,
    speakerKind: "expert",
    expertId: pm.id,
    content: "PM: I agree on the pain, but timing matters; we lack ops headcount.",
  });
  if (options.completed ?? true) {
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
  }
  return { panelName: panel.name };
}

function makeDeps(
  db: CouncilDatabase,
  engine: CouncilEngine,
  overrides: Partial<ConcludeDeps> = {},
): ConcludeDeps {
  return {
    engineFactory: () => engine,
    loadTranscript: (panelName: string, debateId?: string): Promise<TranscriptDocument> =>
      loadTranscript(db, panelName, debateId),
    model: "mock-model",
    maxTranscriptChars: 50_000,
    ...overrides,
  };
}

describe("createConcludeSource", () => {
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

  it("maps a completed debate's synthesis into a decision-matrix ConclusionView", async () => {
    const { panelName } = await seedDebate(db);
    const engine = new TrackingMockEngine();
    const source = createConcludeSource(makeDeps(db, engine));

    const view: ConclusionView = await source.synthesize(panelName);

    expect(view.panelName).toBe(panelName);
    expect(view.topic).toBe("Should we migrate to microservices?");
    expect(view.consensus.length).toBeGreaterThan(0);
    expect(view.tensions.length).toBeGreaterThan(0);
    expect(view.recommendation.length).toBeGreaterThan(0);
    expect(view.confidence).toBe("medium");
    expect(view.warnings).toEqual([]);
    expect(view.decisionMatrix.length).toBeGreaterThan(0);
    const dimension = view.decisionMatrix[0];
    expect(dimension?.dimension).toBe("Risk vs Innovation");
    expect(dimension?.stances[0]).toEqual({
      expert: "conservative",
      stance: "Prioritize stability and proven approaches",
    });
    expect(engine.stopCount).toBe(1);
  });

  it("sanitizes every untrusted string field at the view boundary", async () => {
    const { panelName } = await seedDebate(db);
    const maliciousJson = JSON.stringify({
      consensus: ["safe\u0007payload"],
      tensions: ["row\u2028forge"],
      decisionMatrix: [
        {
          dimension: "Risk\rOVERWRITE",
          positions: [{ expert: "CTO\u0007X", stance: "stance\nsecond" }],
        },
      ],
      recommendation: "do\u2029this",
      confidence: "high",
    });
    const engine = new ScriptedSynthEngine(maliciousJson);
    const source = createConcludeSource(makeDeps(db, engine));

    const view = await source.synthesize(panelName);

    // toSingleLineDisplay strips BEL/control chars and collapses CR/LF/U+2028/
    // U+2029 runs to a single space, so no field can CR-overwrite a row or
    // forge a new transcript line.
    expect(view.consensus[0]).toBe("safepayload");
    expect(view.tensions[0]).toBe("row forge");
    expect(view.recommendation).toBe("do this");
    const dimension = view.decisionMatrix[0];
    expect(dimension?.dimension).toBe("Risk OVERWRITE");
    expect(dimension?.stances[0]).toEqual({ expert: "CTOX", stance: "stance second" });
    for (const field of [
      view.consensus[0],
      view.tensions[0],
      view.recommendation,
      dimension?.dimension,
      dimension?.stances[0]?.expert,
      dimension?.stances[0]?.stance,
    ]) {
      expectSingleLine(field);
    }
  });

  it("surfaces sanitized warnings when the selected debate is not completed", async () => {
    const { panelName } = await seedDebate(db, { name: "running-panel", completed: false });
    const engine = new TrackingMockEngine();
    const source = createConcludeSource(makeDeps(db, engine));

    const view = await source.synthesize(panelName);

    expect(view.warnings.length).toBeGreaterThan(0);
    expect(view.warnings[0]).toContain("status");
    for (const warning of view.warnings) {
      expectSingleLine(warning);
    }
  });

  it("stops the engine in finally even when synthesis fails to parse", async () => {
    const { panelName } = await seedDebate(db);
    const engine = new ScriptedSynthEngine("this is not valid json at all");
    const source = createConcludeSource(makeDeps(db, engine));

    await expect(source.synthesize(panelName)).rejects.toThrow();
    expect(engine.stopCount).toBe(1);
  });

  it("resolves the view even when engine.stop() rejects during cleanup", async () => {
    const { panelName } = await seedDebate(db);
    const engine = new ScriptedSynthEngine(VALID_SYNTH_JSON, { stopRejects: true });
    const source = createConcludeSource(makeDeps(db, engine));

    const view = await source.synthesize(panelName);

    expect(view.recommendation).toBe("Start a phased migration behind a feature flag.");
    expect(engine.stopCount).toBe(1);
  });

  it("threads an explicit debateId through to the transcript loader", async () => {
    const { panelName } = await seedDebate(db);
    const calls: { readonly panelName: string; readonly debateId?: string }[] = [];
    const engine = new TrackingMockEngine();
    const source = createConcludeSource(
      makeDeps(db, engine, {
        loadTranscript: (name, debateId) => {
          calls.push({ panelName: name, ...(debateId !== undefined ? { debateId } : {}) });
          return loadTranscript(db, name, debateId);
        },
      }),
    );

    await source.synthesize(panelName, { debateId: undefined });

    expect(calls).toEqual([{ panelName }]);
  });

  it("resolves the view when a live (un-aborted) signal is provided", async () => {
    const { panelName } = await seedDebate(db);
    const controller = new AbortController();
    const engine = new TrackingMockEngine();
    const source = createConcludeSource(makeDeps(db, engine));

    const view = await source.synthesize(panelName, { signal: controller.signal });

    expect(view.confidence).toBe("medium");
    expect(engine.stopCount).toBe(1);
  });

  it("rejects and still stops the engine when the signal is already aborted", async () => {
    const { panelName } = await seedDebate(db);
    const controller = new AbortController();
    controller.abort();
    const engine = new TrackingMockEngine();
    const source = createConcludeSource(makeDeps(db, engine));

    await expect(source.synthesize(panelName, { signal: controller.signal })).rejects.toThrow(
      /cancel/i,
    );
    expect(engine.stopCount).toBe(1);
  });

  it("rejects through the abort race when synthesis fails with a signal attached", async () => {
    const { panelName } = await seedDebate(db);
    const controller = new AbortController();
    const engine = new ScriptedSynthEngine("not json");
    const source = createConcludeSource(makeDeps(db, engine));

    await expect(source.synthesize(panelName, { signal: controller.signal })).rejects.toThrow();
    expect(engine.stopCount).toBe(1);
  });
});

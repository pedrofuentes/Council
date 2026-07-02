/**
 * Tests for wiring the anti-sycophancy quality gate into the debate
 * orchestrator (`Debate.#runAiTurn`), driven by `DebateConfig.qualityGate`.
 *
 * Behavior under test:
 *   - `mode: "off"` (and undefined) — NO-OP: bad responses are accepted,
 *     zero `turn.quality_gate` events, no extra engine sends.
 *   - `mode: "warn"` (default) — a gate-failing response emits ONE
 *     `turn.quality_gate` (action "warned") AND the ORIGINAL response is
 *     still persisted (turn.end carries the original content). No regen.
 *   - `mode: "regenerate"` — a gate-failing response re-prompts the same
 *     expert with the hint appended; a passing regeneration is persisted;
 *     rejected candidate content never appears in any turn.delta/turn.end.
 *     Cap-hit accepts the last candidate (action "accepted_after_cap").
 *   - `priorSpeakers` — first speaker in a round gets [] (disagreement
 *     check skipped); the second speaker gets [firstSlug].
 *   - The regeneration loop is SEPARATE from the engine-error retry loop:
 *     a recoverable engine error during a regeneration still retries via
 *     `turn.retry` without consuming a regeneration attempt.
 *
 * RED at this commit: `DebateConfig.qualityGate` and the
 * `turn.quality_gate` event do not exist yet.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type {
  CouncilEngine,
  EngineErrorCode,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

const cto: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

const cfo: ExpertSpec = {
  id: "01HZ-cfo",
  slug: "cfo",
  displayName: "CFO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CFO.",
};

/** Clean response with a disagreement signal — passes the gate. */
const PASSING =
  "I disagree with that framing because it omitted the failure scenario where the cache invalidation cascade overwhelms the primary database under sustained peak traffic.";

/** Substantive but with no disagreement signal — fails only when prior speakers exist. */
const NEUTRAL =
  "The platform should adopt an event-driven architecture with clearly bounded contexts and asynchronous messaging between independent services across the entire deployment.";

/** Sycophantic + forbidden phrases — fails the gate regardless of prior speakers. */
const SYCO1 =
  "Great point, I agree with the previous speaker and this is a solid analysis that captures the situation extremely well overall.";
const SYCO2 =
  "Great point again, leverage the robust framework because it reflects best practices and holistic synergy across all of the teams.";
const SYCO3 =
  "Great point once more, well said indeed and echoing the synergy that makes this a robust and holistic approach overall.";

const FREEFORM_1R: Omit<DebateConfig, "qualityGate"> = {
  maxRounds: 1,
  maxWordsPerResponse: 0,
  mode: "freeform",
  retryBackoffMs: [1, 2],
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

interface QualityGateEvent {
  readonly kind: "turn.quality_gate";
  readonly expertSlug: string;
  readonly round: number;
  readonly mode: "warn" | "regenerate";
  readonly action: "warned" | "regenerating" | "accepted_after_cap";
  readonly failures: readonly string[];
  readonly regenerationAttempt?: number;
  readonly maxRegenerations?: number;
  readonly priorSpeakers: readonly string[];
}

function gateEvents(events: readonly DebateEvent[]): QualityGateEvent[] {
  return events.filter(
    (e): e is DebateEvent & { kind: "turn.quality_gate" } => e.kind === "turn.quality_gate",
  ) as unknown as QualityGateEvent[];
}

function deltaTexts(events: readonly DebateEvent[]): string {
  return events
    .filter((e): e is DebateEvent & { kind: "turn.delta" } => e.kind === "turn.delta")
    .map((e) => e.text)
    .join("");
}

function turnEndContents(events: readonly DebateEvent[]): string[] {
  return events
    .filter((e): e is DebateEvent & { kind: "turn.end" } => e.kind === "turn.end")
    .map((e) => e.content);
}

/** premiumRequests from the LAST cost.update — the run's final billed count. */
function finalPremiumRequests(events: readonly DebateEvent[]): number {
  const costs = events.filter(
    (e): e is Extract<DebateEvent, { kind: "cost.update" }> => e.kind === "cost.update",
  );
  return costs[costs.length - 1]?.premiumRequests ?? 0;
}

/**
 * Minimal CouncilEngine that returns a SEQUENCE of responses per expert
 * (indexed by send-count, clamped to the last entry) and can inject a
 * per-send terminal error. Lets a regeneration test script distinct
 * responses for successive sends to the same expert — something MockEngine
 * (one fixed response per expert) cannot do.
 */
interface SendFailure {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
}

class ScriptedEngine implements CouncilEngine {
  readonly #experts = new Set<string>();
  readonly #queues: Map<string, readonly string[]>;
  readonly #failures: Map<string, readonly (SendFailure | null)[]>;
  readonly #sendCounts = new Map<string, number>();
  /** Per-expert ordered list of every prompt sent (for assertions). */
  readonly prompts = new Map<string, string[]>();

  constructor(opts: {
    readonly responses: Readonly<Record<string, readonly string[]>>;
    readonly failures?: Readonly<Record<string, readonly (SendFailure | null)[]>>;
  }) {
    this.#queues = new Map(Object.entries(opts.responses));
    this.#failures = new Map(Object.entries(opts.failures ?? {}));
  }

  async start(): Promise<void> {
    // no-op for tests
  }
  async stop(): Promise<void> {
    // no-op for tests
  }
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.add(spec.id);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["mock"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    if (!this.#experts.has(options.expertId)) {
      throw new Error(`Expert ${options.expertId} is not registered`);
    }
    const n = this.#sendCounts.get(options.expertId) ?? 0;
    this.#sendCounts.set(options.expertId, n + 1);
    const promptLog = this.prompts.get(options.expertId) ?? [];
    promptLog.push(options.prompt);
    this.prompts.set(options.expertId, promptLog);

    const fail = this.#failures.get(options.expertId)?.[n] ?? null;
    const queue = this.#queues.get(options.expertId) ?? [];
    const idx = Math.min(n, Math.max(0, queue.length - 1));
    const text = queue[idx] ?? "";
    return this.#stream(options.expertId, text, fail);
  }

  async *#stream(
    expertId: string,
    text: string,
    fail: SendFailure | null,
  ): AsyncGenerator<EngineEvent> {
    if (fail) {
      yield {
        kind: "error",
        expertId,
        error: { code: fail.code, message: fail.message, provider: "mock" },
        recoverable: fail.recoverable,
      };
      return;
    }
    yield { kind: "message.delta", expertId, text };
    yield { kind: "message.complete", expertId, response: { latencyMs: 0 } };
  }
}

describe("Debate quality gate — mode: off / undefined (no-op)", () => {
  it("undefined qualityGate accepts a bad response with zero gate events and one send", async () => {
    const engine = new MockEngine({ responses: { [cto.id]: SYCO1 } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = { ...FREEFORM_1R };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    expect(gateEvents(events)).toHaveLength(0);
    expect(turnEndContents(events)).toEqual([SYCO1]);
    expect(engine.sentPrompts).toHaveLength(1);
  });

  it('mode: "off" is a no-op even for a sycophantic response', async () => {
    const engine = new MockEngine({ responses: { [cto.id]: SYCO1 } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "off", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    expect(gateEvents(events)).toHaveLength(0);
    expect(turnEndContents(events)).toEqual([SYCO1]);
    expect(engine.sentPrompts).toHaveLength(1);
  });
});

describe("Debate quality gate — mode: warn", () => {
  it("flags a gate-failing 2nd speaker but still persists the original response", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: PASSING, [cfo.id]: NEUTRAL },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(cfo);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "warn", maxRegenerations: 1 },
    };
    const events = await collect(new Debate(engine, [cto, cfo], config).run("topic"));

    const gates = gateEvents(events);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.action).toBe("warned");
    expect(gates[0]?.mode).toBe("warn");
    expect(gates[0]?.expertSlug).toBe(cfo.slug);

    // Original response is still persisted unchanged (warn never regenerates).
    expect(turnEndContents(events)).toEqual([PASSING, NEUTRAL]);
    // No extra sends: one per expert.
    expect(engine.sentPrompts).toHaveLength(2);
  });

  it("priorSpeakers: first speaker gets [] (no flag); second gets [firstSlug]", async () => {
    // Both speakers return the same neutral text. The first passes because
    // priorSpeakers is empty (disagreement check skipped); the second fails
    // because it has a prior speaker but no disagreement signal.
    const engine = new MockEngine({
      responses: { [cto.id]: NEUTRAL, [cfo.id]: NEUTRAL },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(cfo);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "warn", maxRegenerations: 1 },
    };
    const events = await collect(new Debate(engine, [cto, cfo], config).run("topic"));

    const gates = gateEvents(events);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.expertSlug).toBe(cfo.slug);
    expect(gates[0]?.priorSpeakers).toEqual([cto.slug]);
  });
});

describe("Debate quality gate — mode: regenerate", () => {
  it("re-prompts on failure and persists a passing regeneration; rejected content never leaks", async () => {
    const engine = new ScriptedEngine({ responses: { [cto.id]: [SYCO1, PASSING] } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    const gates = gateEvents(events);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.action).toBe("regenerating");
    expect(gates[0]?.mode).toBe("regenerate");
    expect(gates[0]?.regenerationAttempt).toBe(1);

    // Accepted (passing) regeneration is what gets persisted.
    expect(turnEndContents(events)).toEqual([PASSING]);
    // Rejected original content never appears in any delta or turn.end.
    expect(deltaTexts(events)).not.toContain(SYCO1);
    expect(turnEndContents(events).join("")).not.toContain(SYCO1);

    // The regeneration prompt carried the regenerate hint.
    const prompts = engine.prompts.get(cto.id) ?? [];
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("rejected");
  });

  it("accepts the last candidate after the regeneration cap is hit", async () => {
    const engine = new ScriptedEngine({
      responses: { [cto.id]: [SYCO1, SYCO2, SYCO3] },
    });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    const gates = gateEvents(events);
    const regenerating = gates.filter((g) => g.action === "regenerating");
    const acceptedAfterCap = gates.filter((g) => g.action === "accepted_after_cap");
    expect(regenerating).toHaveLength(2);
    expect(acceptedAfterCap).toHaveLength(1);

    // Last candidate is accepted and persisted.
    expect(turnEndContents(events)).toEqual([SYCO3]);
    // Earlier rejected candidates never leak into the transcript.
    expect(deltaTexts(events)).not.toContain(SYCO1);
    expect(deltaTexts(events)).not.toContain(SYCO2);
  });

  it("a recoverable engine error during regeneration retries independently of the regen budget", async () => {
    // send #0 → SYCO1 (gate fails) → regenerate attempt 1.
    // send #1 → NETWORK (recoverable) → engine-error retry (turn.retry).
    // send #2 → PASSING (gate passes) → accepted.
    const engine = new ScriptedEngine({
      responses: { [cto.id]: [SYCO1, PASSING, PASSING] },
      failures: {
        [cto.id]: [null, { code: "NETWORK", message: "connection reset", recoverable: true }, null],
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    // Exactly ONE regeneration attempt was spent despite the engine retry.
    const gates = gateEvents(events);
    expect(gates.filter((g) => g.action === "regenerating")).toHaveLength(1);
    expect(gates.filter((g) => g.action === "accepted_after_cap")).toHaveLength(0);

    // The recoverable engine error surfaced as a turn.retry.
    expect(events.some((e) => e.kind === "turn.retry")).toBe(true);

    // The passing regeneration is persisted; no turn-level error leaked.
    expect(turnEndContents(events)).toEqual([PASSING]);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });
});

describe("Debate quality gate — premium-request counting (#1513)", () => {
  it("counts the original send PLUS each regeneration send (cap hit)", async () => {
    // maxRegenerations: 2, every candidate fails the gate → cap is hit after 2
    // regeneration sends. Real engine.send calls: original + 2 regenerations = 3.
    const engine = new ScriptedEngine({
      responses: { [cto.id]: [SYCO1, SYCO2, SYCO3] },
    });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    // Three real premium-incurring sends were issued to the engine...
    expect(engine.prompts.get(cto.id)).toHaveLength(3);
    // ...and the final cost.update reflects every one of them (original + 2).
    expect(finalPremiumRequests(events)).toBe(3);
  });

  it("counts the original send PLUS a single passing regeneration", async () => {
    // original fails, regeneration #1 passes → original + 1 regeneration = 2 sends.
    const engine = new ScriptedEngine({ responses: { [cto.id]: [SYCO1, PASSING] } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    expect(engine.prompts.get(cto.id)).toHaveLength(2);
    expect(finalPremiumRequests(events)).toBe(2);
  });

  it("a passing first response in regenerate mode counts exactly one send", async () => {
    const engine = new ScriptedEngine({ responses: { [cto.id]: [PASSING] } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 3 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    // No regeneration happened — exactly one premium request, as before.
    expect(gateEvents(events)).toHaveLength(0);
    expect(engine.prompts.get(cto.id)).toHaveLength(1);
    expect(finalPremiumRequests(events)).toBe(1);
  });

  it("off mode counts exactly one premium request per turn (unchanged)", async () => {
    const engine = new MockEngine({ responses: { [cto.id]: SYCO1 } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "off", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    expect(engine.sentPrompts).toHaveLength(1);
    expect(finalPremiumRequests(events)).toBe(1);
  });

  it("warn mode flags a failure but adds NO premium requests (still 1/turn)", async () => {
    // SYCO1 fails the gate even with no prior speakers, so warn mode engages —
    // but warn never re-sends, so the premium count must stay at 1.
    const engine = new MockEngine({ responses: { [cto.id]: SYCO1 } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "warn", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    const gates = gateEvents(events);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.action).toBe("warned");
    expect(engine.sentPrompts).toHaveLength(1);
    expect(finalPremiumRequests(events)).toBe(1);
  });

  it("an engine-error retry during regeneration does NOT inflate the premium count", async () => {
    // send #0 → SYCO1 (gate fails) → regenerate attempt 1.
    // send #1 → NETWORK (recoverable) → engine-error retry (turn.retry), SAME
    //           logical regeneration send.
    // send #2 → PASSING (gate passes) → accepted.
    // Three real engine.send calls, but only ONE regeneration send → premium = 2.
    const engine = new ScriptedEngine({
      responses: { [cto.id]: [SYCO1, PASSING, PASSING] },
      failures: {
        [cto.id]: [null, { code: "NETWORK", message: "connection reset", recoverable: true }, null],
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    // The engine was hit three times (the middle one being the retried send)...
    expect(engine.prompts.get(cto.id)).toHaveLength(3);
    // ...yet only original + one logical regeneration are billed: the
    // engine-error retry does NOT bump the premium counter.
    expect(finalPremiumRequests(events)).toBe(2);
  });

  it("a non-recoverable regeneration-send failure is counted exactly once, and the original candidate is kept (#1528)", async () => {
    // send #0 → SYCO1 (gate fails) → regenerate attempt 1.
    // send #1 → PROVIDER_ERROR (non-recoverable) → #streamWithRetry stops
    //           immediately (no engine-error retry, no further regeneration
    //           attempts) even though maxRegenerations is 2.
    // Two real engine.send calls total: original + the one failed
    // regeneration. The failed regeneration is still a real premium-incurring
    // send (#1513/#1528), so it must be billed exactly once: not dropped
    // (which would under-report 1) and not double-counted (which would
    // over-report 3+).
    const engine = new ScriptedEngine({
      responses: { [cto.id]: [SYCO1] },
      failures: {
        [cto.id]: [
          null,
          { code: "PROVIDER_ERROR", message: "provider exploded", recoverable: false },
        ],
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [cto], config).run("topic"));

    // Only two real sends were issued — the non-recoverable failure aborts
    // the regeneration loop before a second attempt is made.
    expect(engine.prompts.get(cto.id)).toHaveLength(2);
    // The failed regeneration send is counted exactly once: original (1) +
    // the failed regeneration (1) = 2.
    expect(finalPremiumRequests(events)).toBe(2);

    // The failure is buffered, not surfaced as a turn-level error, and the
    // pre-regeneration (original) candidate is what gets accepted.
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(turnEndContents(events)).toEqual([SYCO1]);

    // Exactly one regeneration attempt was surfaced before the failure ends
    // the loop and the last-known-good candidate is accepted.
    const gates = gateEvents(events);
    expect(gates.filter((g) => g.action === "regenerating")).toHaveLength(1);
    expect(gates.filter((g) => g.action === "accepted_after_cap")).toHaveLength(1);
  });
});

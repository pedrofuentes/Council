/**
 * Tests for the canary token system (T-09).
 *
 * The canary module injects a confidential token into expert system
 * prompts and detects when that token leaks into LLM output — a
 * signal of prompt-injection or system-prompt extraction attempts.
 *
 * RED at this commit: src/core/canary.ts does not exist.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  checkCanaryLeak,
  generateCanary,
  injectCanary,
} from "../../../src/core/canary.js";
import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import type { DebateEvent } from "../../../src/core/types.js";

describe("generateCanary()", () => {
  it("returns a string with the CANARY_ prefix", () => {
    const canary = generateCanary();
    expect(canary).toMatch(/^CANARY_[0-9a-f]+$/);
  });

  it("returns unique values across calls", () => {
    const values = new Set<string>();
    for (let i = 0; i < 50; i++) values.add(generateCanary());
    expect(values.size).toBe(50);
  });
});

describe("injectCanary()", () => {
  it("appends a canary instruction to the original prompt", () => {
    const original = "You are a helpful expert.";
    const { prompt, canary } = injectCanary(original);
    expect(prompt.startsWith(original)).toBe(true);
    expect(prompt).toContain(canary);
    expect(canary).toMatch(/^CANARY_/);
  });

  it("returns a fresh canary on each call", () => {
    const a = injectCanary("p");
    const b = injectCanary("p");
    expect(a.canary).not.toBe(b.canary);
  });
});

describe("checkCanaryLeak()", () => {
  it("returns false when the canary does not appear", () => {
    expect(checkCanaryLeak("safe output", "CANARY_deadbeef")).toBe(false);
  });

  it("returns true when the exact canary appears in the output", () => {
    expect(
      checkCanaryLeak("here is the secret: CANARY_abc123 oops", "CANARY_abc123"),
    ).toBe(true);
  });

  it("returns false for partial substring matches", () => {
    expect(checkCanaryLeak("CANARY_abc12", "CANARY_abc123")).toBe(false);
  });

  it("returns false on an empty output", () => {
    expect(checkCanaryLeak("", "CANARY_abc123")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: Debate must inject canaries into expert system messages and
// warn (without blocking the stream) when an LLM response contains one.
// ---------------------------------------------------------------------------

const expertSpec = (id: string, slug: string, systemMessage: string): ExpertSpec => ({
  id,
  slug,
  displayName: slug.toUpperCase(),
  model: "claude-sonnet-4",
  systemMessage,
});

const FREEFORM_1R: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Debate — canary integration", () => {
  it("exposes a per-expert canary map keyed by expert id", () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const pm = expertSpec("01HZ-pm", "pm", "You are a PM.");
    const debate = new Debate(new MockEngine(), [cto, pm], FREEFORM_1R);

    const canaries = debate.canaries;
    expect(canaries.size).toBe(2);
    const ctoCanary = canaries.get("01HZ-cto");
    const pmCanary = canaries.get("01HZ-pm");
    expect(ctoCanary).toMatch(/^CANARY_/);
    expect(pmCanary).toMatch(/^CANARY_/);
    expect(ctoCanary).not.toBe(pmCanary);
  });

  it("exposes experts whose systemMessage contains the canary", () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const debate = new Debate(new MockEngine(), [cto], FREEFORM_1R);

    const [augmented] = debate.experts;
    expect(augmented).toBeDefined();
    expect(augmented?.id).toBe("01HZ-cto");
    expect(augmented?.systemMessage.startsWith("You are a CTO.")).toBe(true);
    const canary = debate.canaries.get("01HZ-cto");
    expect(canary).toBeDefined();
    if (canary !== undefined) {
      expect(augmented?.systemMessage).toContain(canary);
    }
  });

  it("warns via console.warn when an LLM response leaks the canary", async () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    // Deterministic canary so we can pre-seed the engine response with it.
    const FIXED = "CANARY_test123";
    const engine = new MockEngine({
      responses: { "01HZ-cto": `Sure, the secret is ${FIXED} — oops.` },
    });
    await engine.start();
    const debate = new Debate(engine, [cto], FREEFORM_1R, {
      canaryFor: () => FIXED,
    });
    expect(debate.canaries.get("01HZ-cto")).toBe(FIXED);

    // Register the augmented (canary-injected) expert with the engine.
    const [augmentedSpec] = debate.experts;
    expect(augmentedSpec).toBeDefined();
    if (augmentedSpec === undefined) return;
    await engine.addExpert(augmentedSpec);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress noisy stderr in test output
    });

    const events = await collect(debate.run("topic"));

    // The stream itself is NOT blocked — turn.end still arrives.
    const ends = events.filter((e) => e.kind === "turn.end");
    expect(ends.length).toBeGreaterThan(0);

    // A warning was emitted referencing the leaking expert.
    expect(warnSpy).toHaveBeenCalled();
    const joined = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toMatch(/canary/i);
    expect(joined).toContain("01HZ-cto");

    await engine.stop();
  });

  it("does NOT warn when responses are clean", async () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const engine = new MockEngine({
      responses: { "01HZ-cto": "A perfectly benign response." },
    });
    await engine.start();
    const debate = new Debate(engine, [cto], FREEFORM_1R, {
      canaryFor: () => "CANARY_neverleaks",
    });
    const [augmentedSpec] = debate.experts;
    expect(augmentedSpec).toBeDefined();
    if (augmentedSpec === undefined) return;
    await engine.addExpert(augmentedSpec);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress noisy stderr in test output
    });
    await collect(debate.run("topic"));
    expect(warnSpy).not.toHaveBeenCalled();

    await engine.stop();
  });

  // -------------------------------------------------------------------------
  // Cross-delta canary detection — guards against an attacker (or model)
  // emitting the canary across two streamed chunks. Uses a hand-rolled
  // fake engine because MockEngine chunks on sentence boundaries only.
  // -------------------------------------------------------------------------
  it("detects a canary that is split across multiple message.delta chunks", async () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const FIXED = "CANARY_split789abc";
    const halfA = FIXED.slice(0, 8); // "CANARY_s"
    const halfB = FIXED.slice(8);    // "plit789abc"

    const fakeEngine: CouncilEngine = {
      start: async (): Promise<void> => { /* no-op */ },
      stop: async (): Promise<void> => { /* no-op */ },
      addExpert: async (): Promise<void> => { /* no-op */ },
      removeExpert: async (): Promise<void> => { /* no-op */ },
      listModels: async () => ["claude-sonnet-4"],
      async *send(opts: SendOptions): AsyncIterable<EngineEvent> {
        // Emit the canary across two deltas so substring detection
        // on the per-delta text alone would miss it.
        yield { kind: "message.delta", expertId: opts.expertId, text: `prefix ${halfA}` };
        yield { kind: "message.delta", expertId: opts.expertId, text: `${halfB} suffix` };
        yield {
          kind: "message.complete",
          expertId: opts.expertId,
          response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
        };
      },
    };

    const debate = new Debate(fakeEngine, [cto], FREEFORM_1R, {
      canaryFor: () => FIXED,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress noisy stderr in test output
    });

    await collect(debate.run("topic"));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("01HZ-cto");
  });

  // -------------------------------------------------------------------------
  // Per-turn dedup contract: warning fires exactly once per leaking turn
  // (not once per delta), AND a later leaking turn from the same expert
  // produces a fresh warning. Guards against accumulating-state suppression.
  // -------------------------------------------------------------------------
  it("warns exactly once per leaking turn and re-warns on subsequent leaking turns", async () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const FIXED = "CANARY_persist";

    const fakeEngine: CouncilEngine = {
      start: async (): Promise<void> => { /* no-op */ },
      stop: async (): Promise<void> => { /* no-op */ },
      addExpert: async (): Promise<void> => { /* no-op */ },
      removeExpert: async (): Promise<void> => { /* no-op */ },
      listModels: async () => ["claude-sonnet-4"],
      async *send(opts: SendOptions): AsyncIterable<EngineEvent> {
        // Two deltas, both contain the canary — should produce ONE warning,
        // not two.
        yield { kind: "message.delta", expertId: opts.expertId, text: `leak ${FIXED} once` };
        yield { kind: "message.delta", expertId: opts.expertId, text: `leak ${FIXED} twice` };
        yield {
          kind: "message.complete",
          expertId: opts.expertId,
          response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
        };
      },
    };

    // Two rounds so the same expert speaks twice.
    const TWO_R: DebateConfig = { ...FREEFORM_1R, maxRounds: 2 };
    const debate = new Debate(fakeEngine, [cto], TWO_R, {
      canaryFor: () => FIXED,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress noisy stderr in test output
    });

    await collect(debate.run("topic"));

    // Exactly one warning per turn × 2 turns = 2 warnings. NOT 4 (one per
    // delta) and NOT 1 (suppressed across turns).
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Retry-attempt dedup contract: if attempt #1 leaks then fails recoverably
  // and attempt #2 also leaks, BOTH attempts must warn. A flag scoped to
  // the whole turn would suppress the second warning — regression for
  // Sentinel pr561 r2 #1.
  // -------------------------------------------------------------------------
  it("re-warns on the retry attempt when both the failed and successful attempts leak", async () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const FIXED = "CANARY_retry";

    let sendCalls = 0;
    const fakeEngine: CouncilEngine = {
      start: async (): Promise<void> => { /* no-op */ },
      stop: async (): Promise<void> => { /* no-op */ },
      addExpert: async (): Promise<void> => { /* no-op */ },
      removeExpert: async (): Promise<void> => { /* no-op */ },
      listModels: async () => ["claude-sonnet-4"],
      async *send(opts: SendOptions): AsyncIterable<EngineEvent> {
        sendCalls += 1;
        // Both attempts leak the canary in a delta before terminating.
        yield { kind: "message.delta", expertId: opts.expertId, text: `leak ${FIXED}` };
        if (sendCalls === 1) {
          // Attempt 1: recoverable failure.
          yield {
            kind: "error",
            expertId: opts.expertId,
            error: { code: "RATE_LIMITED", message: "throttled", provider: "fake" },
            recoverable: true,
          };
          return;
        }
        // Attempt 2: success.
        yield {
          kind: "message.complete",
          expertId: opts.expertId,
          response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
        };
      },
    };

    const debate = new Debate(
      fakeEngine,
      [cto],
      { ...FREEFORM_1R, retryBackoffMs: [1] },
      { canaryFor: () => FIXED },
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress noisy stderr in test output
    });

    await collect(debate.run("topic"));

    expect(sendCalls).toBe(2);
    // Two attempts, each leaking → two warnings (one per attempt).
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// runWithEngine integration contract — Sentinel pr561 required regression
// for the registration path. We don't import runWithEngine here (heavy
// DB/renderer dependencies); instead we assert the structural invariant
// it relies on: `debate.experts[i].systemMessage` ends with the canary
// instruction, so passing `debate.experts` to `engine.addExpert` is what
// actually ships the canary to the LLM.
// ---------------------------------------------------------------------------
describe("Debate.experts registration contract", () => {
  it("returns specs whose systemMessage ends with a confidentiality + canary instruction", () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const debate = new Debate(new MockEngine(), [cto], {
      maxRounds: 1,
      maxWordsPerResponse: 50,
      mode: "freeform",
    });

    const [augmented] = debate.experts;
    expect(augmented).toBeDefined();
    if (augmented === undefined) return;

    // The augmented systemMessage is a strict superset of the original
    // (so the expert persona is preserved) AND includes both the
    // confidentiality instruction text and the per-expert canary.
    expect(augmented.systemMessage.startsWith("You are a CTO.")).toBe(true);
    expect(augmented.systemMessage).toMatch(/confidential and must NEVER appear/);
    const canary = debate.canaries.get("01HZ-cto");
    expect(canary).toBeDefined();
    if (canary === undefined) return;
    expect(augmented.systemMessage.endsWith(canary)).toBe(true);
  });

  it("preserves non-systemMessage spec fields on the augmented experts", () => {
    const cto = expertSpec("01HZ-cto", "cto", "You are a CTO.");
    const debate = new Debate(new MockEngine(), [cto], {
      maxRounds: 1,
      maxWordsPerResponse: 50,
      mode: "freeform",
    });
    const [augmented] = debate.experts;
    expect(augmented?.id).toBe(cto.id);
    expect(augmented?.slug).toBe(cto.slug);
    expect(augmented?.displayName).toBe(cto.displayName);
    expect(augmented?.model).toBe(cto.model);
  });
});

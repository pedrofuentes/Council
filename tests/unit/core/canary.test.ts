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
import type { ExpertSpec } from "../../../src/engine/index.js";
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
});

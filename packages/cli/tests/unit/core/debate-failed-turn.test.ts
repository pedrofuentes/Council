/**
 * Tests for surfacing FAILED expert turns in structured debate (#108).
 *
 * Background: in `Debate.#runStructured`, each phase feeds the surviving
 * turns forward into the next phase's prompts (opening → cross-exam →
 * rebuttal → synthesis). Before #108, when `#runTurn` returned `null`
 * (the turn failed / errored / came back empty and was not recovered by
 * retry), the failure was silently ELIDED from the prior-turn arrays.
 * Subsequent phase prompts then treated the expert as if they never
 * spoke, so the other experts could not address the gap and the debate
 * was silently degraded.
 *
 * Fix: a non-recovered failed turn is recorded as an explicit placeholder
 * ("<name> did not respond in the <phase> phase.") in the phase's
 * prior-turn array. That marker is the inter-expert transcript trace —
 * it surfaces into every SUBSEQUENT phase prompt (cross-exam, rebuttal,
 * synthesis) so the gap is visible. (The user-visible `error` event is
 * already emitted inside `#runTurn`; this is the additional
 * prompt-channel surfacing #108 asks for.)
 *
 * The surfaced signal travels through the phase-prompt builders, which
 * wrap all prior-turn content in `<from_expert>` fences and defang it
 * (`sanitizeFenced` for content, `safeAttrName` for the name attribute).
 * This is a MULTI-LINE prompt sink (not a single-line terminal sink), so
 * the adversarial-byte oracle below asserts the prompt-injection bytes
 * `sanitizeFenced`/`safeAttrName` strip (bidi, zero-width, C0-except
 * tab/newline/CR, DEL) are absent — newlines legitimately survive the
 * fence, so a single-line assertion would not apply here.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

const cto: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};
const pm: ExpertSpec = {
  id: "01HZ-pm",
  slug: "pm",
  displayName: "PM",
  model: "claude-sonnet-4",
  systemMessage: "You are a PM.",
};

// retryBackoffMs is tightened so the recoverable-retry test resolves in
// microseconds; the other tests use non-recoverable / throw failures that
// never retry, so the value is irrelevant to them.
const STRUCTURED: DebateConfig = {
  maxRounds: 99,
  maxWordsPerResponse: 50,
  mode: "structured",
  retryBackoffMs: [1, 2],
};

const OPENING_MARKER = "(PM did not respond in the opening phase.)";
const CROSS_EXAM_MARKER = "(PM did not respond in the cross-examination phase.)";
const REBUTTAL_MARKER = "(PM did not respond in the rebuttal phase.)";

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

/** All prompts sent to `expertId` whose text starts with `prefix`. */
function promptsFor(engine: MockEngine, expertId: string, prefix: string): readonly string[] {
  return engine.sentPrompts
    .filter((s) => s.expertId === expertId && s.prompt.startsWith(prefix))
    .map((s) => s.prompt);
}

describe("Structured debate — failed turns are surfaced, not silently dropped (#108)", () => {
  it("surfaces a stopped-with-error opening failure as a placeholder in later phase prompts", async () => {
    // Panel order [cto, pm]. PM's opening (its 1st send) fails with a
    // NON-recoverable code (no retry) → #runTurn returns null.
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening.", "01HZ-pm": "PM must not be quoted." },
      failOnSend: {
        expertId: "01HZ-pm",
        afterN: 0,
        failures: 1,
        code: "MODEL_UNAVAILABLE",
        message: "model down",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Ship the MVP?"));

    // BEFORE the fix, PM is absent from openingTurns, so CTO's cross-exam
    // has no "other" opening to quote and buildCrossExamPrompt returns null
    // — CTO's cross-exam turn is SKIPPED entirely (no such prompt exists).
    // AFTER the fix, CTO is cross-examined against PM's failure placeholder.
    const ctoCross = promptsFor(engine, cto.id, "Cross-examination on:");
    expect(ctoCross).toHaveLength(1);
    expect(ctoCross[0]).toContain(OPENING_MARKER);
    // Attributed to PM via the fence name attribute (names the expert).
    expect(ctoCross[0]).toContain('<from_expert name="PM">');
    // PM's real (never-produced) opening content is NOT fabricated.
    expect(ctoCross[0]).not.toContain("PM must not be quoted.");

    // The gap must PROPAGATE to the synthesis phase too (openingTurns feed
    // every later phase).
    const ctoSynth = promptsFor(engine, cto.id, "Synthesis and final position on:");
    expect(ctoSynth).toHaveLength(1);
    expect(ctoSynth[0]).toContain(OPENING_MARKER);
    expect(ctoSynth[0]).toContain('<from_expert name="PM" phase="opening">');
  });

  it("surfaces a THROWN opening failure (unregistered expert) as the same placeholder", async () => {
    // Second failure mode of the class: engine.send() throws synchronously.
    // PM is intentionally NOT registered, so every PM send throws; the
    // opening throw is caught by the turn loop and returns null.
    const engine = new MockEngine({ responses: { "01HZ-cto": "CTO opening." } });
    await engine.start();
    await engine.addExpert(cto);
    // PM deliberately left unregistered.

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Topic?"));

    const ctoCross = promptsFor(engine, cto.id, "Cross-examination on:");
    expect(ctoCross).toHaveLength(1);
    expect(ctoCross[0]).toContain(OPENING_MARKER);
  });

  it("surfaces a cross-examination-phase failure as a placeholder in the rebuttal and synthesis prompts (#2065)", async () => {
    // Panel order [cto, pm]. PM's opening (its 1st send) SUCCEEDS; its
    // cross-examination send (2nd) fails with a NON-recoverable code (no
    // retry) → #runTurn returns null for that phase only. Rebuttal (3rd)
    // and synthesis (4th) succeed again, so this exercises ONLY the
    // `crossExamTurns.push(marker)` branch at debate.ts:584 — the branch
    // #2065 flagged as untested (all 5 pre-existing tests used
    // `afterN: 0`, an opening-only failure).
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening.", "01HZ-pm": "PM real content." },
      failOnSend: {
        expertId: "01HZ-pm",
        afterN: 1,
        failures: 1,
        code: "MODEL_UNAVAILABLE",
        message: "model down",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Ship the MVP?"));

    // CTO's rebuttal prompt quotes PM's REAL opening (phase="opening")
    // immediately followed by the cross-exam MARKER (phase="cross-exam"),
    // not PM's real content — which was never produced for that phase.
    // Anchoring on the exact `phase="cross-exam">\n<marker>` substring
    // pins BOTH the marker CONTENT and its PHASE placement: a
    // routing regression that pushes the marker to the wrong array
    // (e.g. openingTurns or rebuttalTurns instead of crossExamTurns)
    // removes this exact substring and fails the test (proven below by
    // temporarily breaking the routing and observing the failure).
    const ctoRebuttal = promptsFor(engine, cto.id, "Rebuttal on:");
    expect(ctoRebuttal).toHaveLength(1);
    expect(ctoRebuttal[0]).toContain('<from_expert name="PM" phase="opening">\nPM real content.');
    expect(ctoRebuttal[0]).toContain(`phase="cross-exam">\n${CROSS_EXAM_MARKER}`);

    // The gap must PROPAGATE to the synthesis phase too (crossExamTurns
    // feeds every later phase, same as openingTurns).
    const ctoSynth = promptsFor(engine, cto.id, "Synthesis and final position on:");
    expect(ctoSynth).toHaveLength(1);
    expect(ctoSynth[0]).toContain(`phase="cross-exam">\n${CROSS_EXAM_MARKER}`);
  });

  it("surfaces a rebuttal-phase failure as a placeholder in the synthesis prompt (#2065)", async () => {
    // Panel order [cto, pm]. PM's opening (1st) and cross-examination
    // (2nd) sends SUCCEED; its rebuttal send (3rd) fails with a
    // NON-recoverable code (no retry). Synthesis (4th) succeeds again, so
    // this exercises ONLY the `rebuttalTurns.push(marker)` branch at
    // debate.ts:585 — the other branch #2065 flagged as untested.
    // rebuttalTurns is consumed EXCLUSIVELY by buildSynthesisPrompt
    // (never by buildRebuttalPrompt itself, since rebuttal turns are
    // still being produced during that phase), so synthesis is the only
    // place this marker can surface.
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening.", "01HZ-pm": "PM real content." },
      failOnSend: {
        expertId: "01HZ-pm",
        afterN: 2,
        failures: 1,
        code: "MODEL_UNAVAILABLE",
        message: "model down",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Ship the MVP?"));

    // Anchoring on `phase="rebuttal">\n<marker>` pins both the marker
    // CONTENT and its PHASE placement: a routing regression that pushes
    // the marker to the wrong array (e.g. crossExamTurns instead of
    // rebuttalTurns) removes this exact substring and fails the test
    // (proven below by temporarily breaking the routing and observing
    // the failure).
    const ctoSynth = promptsFor(engine, cto.id, "Synthesis and final position on:");
    expect(ctoSynth).toHaveLength(1);
    expect(ctoSynth[0]).toContain(`phase="rebuttal">\n${REBUTTAL_MARKER}`);
    // PM's real cross-exam content DID succeed and must still be quoted
    // (only the rebuttal branch failed) — guards against a regression
    // that clobbers unrelated phases.
    expect(ctoSynth[0]).toContain('<from_expert name="PM" phase="cross-exam">\nPM real content.');
  });

  it("does NOT surface a failure when a recoverable error is retried to success", async () => {
    // PM's opening fails ONCE recoverably then the retry succeeds, so the
    // turn's FINAL outcome is success — no placeholder, and PM's recovered
    // content flows forward normally.
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening.", "01HZ-pm": "PM recovered opening." },
      failOnSend: {
        expertId: "01HZ-pm",
        afterN: 0,
        failures: 1,
        code: "RATE_LIMITED",
        message: "throttled",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Topic?"));

    for (const s of engine.sentPrompts) {
      expect(s.prompt).not.toContain("did not respond");
    }
    // CTO's cross-exam quotes PM's RECOVERED opening, exactly as a normal run.
    const ctoCross = promptsFor(engine, cto.id, "Cross-examination on:");
    expect(ctoCross).toHaveLength(1);
    expect(ctoCross[0]).toContain("PM recovered opening.");
  });

  it("leaves an all-success debate byte-for-byte unchanged (no spurious placeholder)", async () => {
    // Inverse invariant: when every turn succeeds no placeholder appears
    // anywhere, and CTO's cross-exam quotes PM's real opening.
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening.", "01HZ-pm": "PM opening." },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Topic?"));

    for (const s of engine.sentPrompts) {
      expect(s.prompt).not.toContain("did not respond");
    }
    const ctoCross = promptsFor(engine, cto.id, "Cross-examination on:");
    expect(ctoCross).toHaveLength(1);
    expect(ctoCross[0]).toContain("PM opening.");
  });

  it("defangs a malicious expert displayName in the surfaced placeholder", async () => {
    // Adversarial-byte oracle for the prompt sink. The placeholder embeds
    // the (untrusted) displayName; the phase-prompt builders must strip the
    // prompt-injection bytes before it reaches the model.
    const evilPm: ExpertSpec = {
      ...pm,
      // bidi override + isolate, zero-width + BOM, BEL + SOH (C0) + DEL.
      displayName: "PM\u202E\u2066\u200B\uFEFF\u0007\u0001\u007FX",
    };
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening." },
      failOnSend: {
        expertId: "01HZ-pm",
        afterN: 0,
        failures: 1,
        code: "MODEL_UNAVAILABLE",
        message: "model down",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(evilPm);

    await collect(new Debate(engine, [cto, evilPm], STRUCTURED).run("Topic?"));

    const ctoCross = promptsFor(engine, cto.id, "Cross-examination on:");
    expect(ctoCross).toHaveLength(1);
    const prompt = ctoCross[0] ?? "";

    // Bidi override/isolate (Trojan Source) stripped.
    expect(prompt).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    // Zero-width / BOM stripped.
    expect(prompt).not.toMatch(/[\u200B-\u200F\uFEFF]/);
    // C0 controls (except tab/newline/CR) and DEL stripped. Newlines are a
    // legitimate part of the fenced multi-line prompt and are excluded here.
    // eslint-disable-next-line no-control-regex
    expect(prompt).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    // The defanged name survives and the failure is still stated.
    expect(prompt).toContain("PMX did not respond in the opening phase.");
  });
});

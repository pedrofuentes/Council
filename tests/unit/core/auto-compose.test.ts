/**
 * Tests for `autoComposePanel()` — the LLM meta-prompt that designs an
 * expert panel from a topic when the user does not pass `--template`.
 *
 * Strategy: implement a tiny in-test `StubEngine` so we can deterministically
 * control what the "composer" expert returns. MockEngine is keyed by runtime
 * expertId (ULID) which is generated inside autoComposePanel — too awkward
 * to seed from outside.
 *
 * RED at this commit: src/core/auto-compose.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import { autoComposePanel } from "../../../src/core/auto-compose.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";

interface StubEngineOptions {
  readonly response: string;
}

class StubEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly sentPrompts: { readonly expertId: string; readonly prompt: string }[] = [];
  readonly addedSpecs: ExpertSpec[] = [];
  startCalls = 0;
  stopCalls = 0;
  readonly #response: string;

  constructor(opts: StubEngineOptions) {
    this.#response = opts.response;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.set(spec.id, spec);
    this.addedSpecs.push(spec);
  }

  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }

  async listModels(): Promise<readonly string[]> {
    return ["stub-model"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    if (!this.#experts.has(options.expertId)) {
      throw new Error(`Expert ${options.expertId} is not registered`);
    }
    this.sentPrompts.push({ expertId: options.expertId, prompt: options.prompt });
    const text = this.#response;
    return this.#stream(options.expertId, text);
  }

  async *#stream(expertId: string, text: string): AsyncGenerator<EngineEvent, void, void> {
    yield { kind: "message.delta", expertId, text };
    yield {
      kind: "message.complete",
      expertId,
      response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
    };
  }
}

const validPanel = {
  name: "test-panel",
  description: "Test panel for unit tests",
  experts: [
    {
      slug: "expert-a",
      displayName: "Expert A",
      role: "Role A",
      expertise: { weightedEvidence: ["Evidence 1"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Stance A is built on careful reasoning.",
    },
    {
      slug: "expert-b",
      displayName: "Expert B",
      role: "Role B",
      expertise: { weightedEvidence: ["Evidence 2"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Stance B challenges majority opinion.",
    },
    {
      slug: "expert-c",
      displayName: "Expert C",
      role: "Role C",
      expertise: { weightedEvidence: ["Evidence 3"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Stance C grounds itself in customer outcomes.",
    },
  ],
};

describe("autoComposePanel", () => {
  it("returns a validated PanelDefinition when the engine returns valid JSON", async () => {
    const engine = new StubEngine({ response: JSON.stringify(validPanel) });
    await engine.start();
    const result = await autoComposePanel("Should we adopt microservices?", engine);
    expect(result.name).toBe("test-panel");
    expect(result.description).toBe("Test panel for unit tests");
    expect(result.experts).toHaveLength(3);
    expect(result.experts.map((e) => e.slug)).toEqual(["expert-a", "expert-b", "expert-c"]);
  });

  it("throws a descriptive error when the engine returns malformed JSON", async () => {
    const engine = new StubEngine({ response: "not json at all { invalid" });
    await engine.start();
    await expect(
      autoComposePanel("topic", engine),
    ).rejects.toThrow(/JSON|parse/i);
  });

  it("throws a descriptive error when the JSON fails Zod validation", async () => {
    const invalid = { name: "x", description: "y", experts: [] };
    const engine = new StubEngine({ response: JSON.stringify(invalid) });
    await engine.start();
    await expect(autoComposePanel("topic", engine)).rejects.toThrow(/experts|valid/i);
  });

  it("strips markdown code fences if the model wraps JSON in them", async () => {
    const fenced = "```json\n" + JSON.stringify(validPanel) + "\n```";
    const engine = new StubEngine({ response: fenced });
    await engine.start();
    const result = await autoComposePanel("topic", engine);
    expect(result.name).toBe("test-panel");
  });

  it("includes the topic in the prompt sent to the composer", async () => {
    const engine = new StubEngine({ response: JSON.stringify(validPanel) });
    await engine.start();
    await autoComposePanel("Should we deprecate Python 2?", engine);
    expect(engine.sentPrompts).toHaveLength(1);
    expect(engine.sentPrompts[0]?.prompt).toContain("Should we deprecate Python 2?");
  });

  it("primes the composer expert with a meta-prompt mentioning panel composition", async () => {
    const engine = new StubEngine({ response: JSON.stringify(validPanel) });
    await engine.start();
    await autoComposePanel("topic", engine);
    expect(engine.addedSpecs).toHaveLength(1);
    const composer = engine.addedSpecs[0];
    expect(composer?.systemMessage).toMatch(/panel composition|panel of/i);
    expect(composer?.systemMessage).toMatch(/JSON/);
  });

  it("respects minExperts and maxExperts options in the meta-prompt", async () => {
    const engine = new StubEngine({ response: JSON.stringify(validPanel) });
    await engine.start();
    await autoComposePanel("topic", engine, { minExperts: 4, maxExperts: 6 });
    const composer = engine.addedSpecs[0];
    expect(composer?.systemMessage).toContain("4");
    expect(composer?.systemMessage).toContain("6");
  });

  it("uses the provided defaultModel for the composer expert", async () => {
    const engine = new StubEngine({ response: JSON.stringify(validPanel) });
    await engine.start();
    await autoComposePanel("topic", engine, { defaultModel: "gpt-test-model" });
    expect(engine.addedSpecs[0]?.model).toBe("gpt-test-model");
  });

  it("removes the composer expert after composition completes (cleanup)", async () => {
    const engine = new StubEngine({ response: JSON.stringify(validPanel) });
    await engine.start();
    await autoComposePanel("topic", engine);
    // After completion the engine should not retain the composer.
    // Re-adding the same id should succeed (because removeExpert ran).
    const composerId = engine.addedSpecs[0]?.id ?? "";
    await expect(engine.addExpert({
      id: composerId,
      slug: "x",
      displayName: "x",
      model: "m",
      systemMessage: "m",
    })).resolves.not.toThrow();
  });
});

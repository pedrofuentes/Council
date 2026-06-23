import { describe, expect, it, vi } from "vitest";

import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import { createChatEngineSource } from "../../../src/tui/adapters/chat-engine-session.js";

const spec: ExpertSpec = {
  id: "01JCHATEXPERTSPEC0000000000",
  slug: "cto",
  displayName: "Chief Technology Officer",
  model: "mock-model",
  systemMessage: "You are the CTO.",
};

interface StubEngine extends CouncilEngine {
  readonly calls: string[];
  readonly sent: SendOptions[];
}

function createStubEngine(overrides: Partial<CouncilEngine> = {}): StubEngine {
  const calls: string[] = [];
  const sent: SendOptions[] = [];
  return {
    calls,
    sent,
    async start(): Promise<void> {
      calls.push("start");
      await overrides.start?.();
    },
    async stop(): Promise<void> {
      calls.push("stop");
      await overrides.stop?.();
    },
    async addExpert(expert: ExpertSpec): Promise<void> {
      calls.push(`addExpert:${expert.id}`);
      await overrides.addExpert?.(expert);
    },
    async removeExpert(expertId: string): Promise<void> {
      calls.push(`removeExpert:${expertId}`);
      await overrides.removeExpert?.(expertId);
    },
    send(options: SendOptions): AsyncIterable<EngineEvent> {
      calls.push(`send:${options.expertId}`);
      sent.push(options);
      return (
        overrides.send?.(options) ?? {
          async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
            yield {
              kind: "message.complete",
              expertId: options.expertId,
              response: { latencyMs: 1 },
            };
          },
        }
      );
    },
    async listModels(): Promise<readonly string[]> {
      calls.push("listModels");
      return overrides.listModels?.() ?? ["mock-model"];
    },
  };
}

describe("createChatEngineSource", () => {
  it("builds the expert spec, starts the engine, binds the spec id, proxies send, and closes", async () => {
    const engine = createStubEngine();
    const buildSpec = vi.fn<(slug: string) => Promise<ExpertSpec>>(async () => spec);
    const source = createChatEngineSource({
      buildSpec,
      engineFactory: () => engine,
    });

    const handle = await source.open("cto");
    const signal = new AbortController().signal;
    const events = handle.send({ expertId: handle.expertId, prompt: "hello", signal });
    await handle.close();

    expect(buildSpec).toHaveBeenCalledExactlyOnceWith("cto");
    expect(handle.expertId).toBe(spec.id);
    expect(events).toBeDefined();
    expect(engine.sent).toEqual([{ expertId: spec.id, prompt: "hello", signal }]);
    expect(engine.calls).toEqual([`start`, `addExpert:${spec.id}`, `send:${spec.id}`, "stop"]);
  });

  it("stops the engine and rethrows when addExpert fails after start", async () => {
    const engine = createStubEngine({
      addExpert: async () => {
        throw new Error("bind failed");
      },
    });
    const source = createChatEngineSource({
      buildSpec: async () => spec,
      engineFactory: () => engine,
    });

    await expect(source.open("cto")).rejects.toThrow("bind failed");

    expect(engine.calls).toEqual(["start", `addExpert:${spec.id}`, "stop"]);
  });
});

/**
 * Regression tests for T-07 / F-01: duplicate rendering of expert answers
 * during REAL-engine (streaming) debates.
 *
 * The Copilot SDK streams a response as incremental `assistant.message_delta`
 * chunks AND then fires a terminal `assistant.message` carrying the full
 * assembled content. The adapter previously re-emitted that terminal message
 * as an extra `message.delta`, so `core/debate.ts` (which accumulates
 * `content += delta`) and every renderer saw the answer TWICE
 * ("Falcon DriftFalcon Drift").
 *
 * These tests drive the REAL `CopilotEngine` adapter over a mocked SDK (so the
 * fix — which lives in the adapter's SDK-stream consumption — is exercised
 * end-to-end) through a full `Debate` into both the plain and Ink renderers,
 * asserting the answer is rendered EXACTLY ONCE. The `--engine mock` path never
 * fires `assistant.message`, so it is unaffected; that is covered by the
 * existing mock-engine render tests.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

import { Debate, type DebateConfig } from "../../src/core/debate.js";
import type { CouncilEngine, ExpertSpec } from "../../src/engine/index.js";
import type { DebateEvent } from "../../src/core/types.js";
import type { Sink } from "../../src/cli/renderers/types.js";
import { PlainRenderer } from "../../src/cli/renderers/plain.js";
import { DebateApp } from "../../src/cli/renderers/ink/InkRenderer.js";

interface QueuedEvent {
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

interface MockSdkState {
  sessionCount: number;
  readonly sendQueues: Map<string, QueuedEvent[]>;
}

// Module-level state the mocked SDK reads. Populated per-test with the exact
// event sequence a real streaming provider emits (deltas + terminal message).
const mockState: MockSdkState = {
  sessionCount: 0,
  sendQueues: new Map(),
};

vi.mock("@github/copilot-sdk", () => {
  class MockCopilotSession {
    readonly id: string;
    readonly handlers = new Map<string, ((evt: unknown) => void)[]>();
    constructor(id: string) {
      this.id = id;
    }
    on(event: string, handler: (evt: unknown) => void): () => void {
      const arr = this.handlers.get(event) ?? [];
      arr.push(handler);
      this.handlers.set(event, arr);
      return () => {
        const current = this.handlers.get(event);
        if (!current) return;
        const idx = current.indexOf(handler);
        if (idx >= 0) current.splice(idx, 1);
      };
    }
    async send(_options: { prompt: string }): Promise<void> {
      const queue = mockState.sendQueues.get(this.id) ?? [];
      for (const evt of queue) {
        const handlers = this.handlers.get(evt.kind) ?? [];
        for (const h of handlers) h({ data: evt.data });
        // Yield so the adapter's async generator can drain each event.
        await new Promise((resolve) => setImmediate(resolve));
      }
      const idleHandlers = this.handlers.get("session.idle") ?? [];
      for (const h of idleHandlers) h({});
    }
    async abort(): Promise<void> {
      // no-op: these tests never abort an in-flight send
    }
    async disconnect(): Promise<void> {
      // no-op: the mock session holds no resources to release
    }
  }
  class MockCopilotClient {
    async start(): Promise<void> {
      // no-op: no real Copilot subprocess to spawn
    }
    async stop(): Promise<void> {
      // no-op: nothing to tear down
    }
    async forceStop(): Promise<void> {
      // no-op: nothing to reap
    }
    async createSession(_opts: unknown): Promise<MockCopilotSession> {
      const id = `session-${mockState.sessionCount++}`;
      return new MockCopilotSession(id);
    }
    async listModels(): Promise<{ id: string }[]> {
      return [];
    }
  }
  return { CopilotClient: MockCopilotClient };
});

// Import AFTER vi.mock so the adapter binds to the mocked SDK.
const { CopilotEngine } = await import("../../src/engine/copilot/adapter.js");

const expert: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

const config: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [1, 2],
};

// Distinctive answer token split across streaming deltas, followed by the
// terminal full-content message — the shape that previously doubled.
const ANSWER = "Kestrelium";
const STREAMING_QUEUE: QueuedEvent[] = [
  { kind: "assistant.message_delta", data: { deltaContent: "Kest" } },
  { kind: "assistant.message_delta", data: { deltaContent: "relium" } },
  { kind: "assistant.message", data: { content: ANSWER } },
];

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Build and run a one-round, one-expert freeform debate against the REAL
 * Copilot adapter (mocked SDK), returning the `DebateEvent` stream renderers
 * consume. Mirrors `runWithEngine`'s expert-registration order.
 */
async function runStreamingDebate(engine: CouncilEngine): Promise<AsyncIterable<DebateEvent>> {
  await engine.start();
  const debate = new Debate(engine, [expert], config);
  for (const augmented of debate.experts) {
    await engine.addExpert(augmented);
  }
  return debate.run("What is the biggest risk of shipping without observability?");
}

describe("duplicate streaming render (T-07 / F-01)", () => {
  beforeEach(() => {
    mockState.sessionCount = 0;
    mockState.sendQueues.clear();
    mockState.sendQueues.set("session-0", STREAMING_QUEUE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("plain renderer shows a streamed real-engine response exactly once", async () => {
    const engine = new CopilotEngine();
    let out = "";
    const sink: Sink = {
      write: (text) => {
        out += text;
      },
      writeError: (text) => {
        out += text;
      },
    };

    try {
      const stream = await runStreamingDebate(engine);
      await new PlainRenderer(sink, { color: false }).render(stream);
    } finally {
      await engine.stop();
    }

    expect(occurrences(out, ANSWER)).toBe(1);
  });

  it("ink renderer shows a streamed real-engine response exactly once", async () => {
    const engine = new CopilotEngine();
    const complete = deferred();

    try {
      const stream = await runStreamingDebate(engine);
      const ui = render(<DebateApp events={stream} onComplete={() => complete.resolve()} />);
      await complete.promise;
      // Let the final render commit land before reading the frame.
      await new Promise((resolve) => setImmediate(resolve));
      const frame = stripAnsi(ui.lastFrame() ?? "");
      expect(occurrences(frame, ANSWER)).toBe(1);
      ui.unmount();
    } finally {
      await engine.stop();
    }
  });
});

/**
 * Tests for the Copilot SDK adapter.
 *
 * The SDK is mocked via vi.mock so these tests run without a real Copilot
 * subscription. Real-SDK integration tests live elsewhere and are gated
 * behind COUNCIL_INTEGRATION_TESTS=true.
 *
 * RED at this commit: src/engine/copilot/adapter.ts does not exist yet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
} from "../../../../src/engine/index.js";
import { KNOWN_MODELS } from "../../../../src/engine/models.js";

// In-memory state the mock SDK manipulates so tests can introspect it.
interface MockSession {
  readonly id: string;
  readonly model: string;
  readonly availableTools?: readonly string[];
  events: Record<string, unknown>[];
  disconnected: boolean;
}

interface MockModelInfo {
  readonly id: string;
  readonly name: string;
  readonly capabilities: Record<string, never>;
}

interface MockClientState {
  started: boolean;
  stopped: boolean;
  sessions: MockSession[];
  /** Live MockCopilotSession instances, in creation order. */
  sessionInstances: { listenerCount: () => number }[];
  /** Per-session: queue of events to emit on `send()` */
  sendQueues: Map<string, { kind: string; data: Record<string, unknown> }[]>;
  /** Per-session: error to throw on `send()` (sync) */
  sendErrors: Map<string, Error>;
  listModelsCalls: number;
  listModelsResults: MockModelInfo[];
  listModelsError: Error | undefined;
}

const mockState: MockClientState = {
  started: false,
  stopped: false,
  sessions: [],
  sessionInstances: [],
  sendQueues: new Map(),
  sendErrors: new Map(),
  listModelsCalls: 0,
  listModelsResults: [],
  listModelsError: undefined,
};

vi.mock("@github/copilot-sdk", () => {
  class MockCopilotSession {
    readonly id: string;
    readonly model: string;
    readonly handlers = new Map<string, ((evt: unknown) => void)[]>();
    constructor(id: string, model: string) {
      this.id = id;
      this.model = model;
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
    listenerCount(): number {
      let total = 0;
      for (const arr of this.handlers.values()) total += arr.length;
      return total;
    }
    async send(_options: { prompt: string }): Promise<void> {
      const err = mockState.sendErrors.get(this.id);
      if (err) throw err;
      const queue = mockState.sendQueues.get(this.id) ?? [];
      for (const evt of queue) {
        const handlers = this.handlers.get(evt.kind) ?? [];
        for (const h of handlers) h({ data: evt.data });
        // small delay to allow async iteration to consume each event
        await new Promise((r) => setImmediate(r));
      }
      // Always emit session.idle to mark completion
      const idleHandlers = this.handlers.get("session.idle") ?? [];
      for (const h of idleHandlers) h({});
    }
    async disconnect(): Promise<void> {
      const session = mockState.sessions.find((s) => s.id === this.id);
      if (session) session.disconnected = true;
    }
  }
  class MockCopilotClient {
    async start(): Promise<void> {
      mockState.started = true;
      mockState.stopped = false;
    }
    async stop(): Promise<void> {
      mockState.stopped = true;
    }
    async createSession(opts: {
      model: string;
      systemMessage?: { content: string };
      onPermissionRequest: unknown;
      availableTools?: string[];
    }): Promise<MockCopilotSession> {
      const id = `session-${mockState.sessions.length}`;
      const session = new MockCopilotSession(id, opts.model);
      mockState.sessions.push({
        id,
        model: opts.model,
        ...(opts.availableTools !== undefined ? { availableTools: opts.availableTools } : {}),
        events: [],
        disconnected: false,
      });
      mockState.sessionInstances.push(session);
      return session;
    }
    async listModels(): Promise<MockModelInfo[]> {
      mockState.listModelsCalls += 1;
      if (mockState.listModelsError) {
        throw mockState.listModelsError;
      }
      return mockState.listModelsResults;
    }
  }
  const approveAll = async (): Promise<{ decision: "allow" }> => ({ decision: "allow" });
  return {
    CopilotClient: MockCopilotClient,
    CopilotSession: MockCopilotSession,
    approveAll,
  };
});

// Import AFTER vi.mock so the adapter binds to the mock SDK.
const { CopilotEngine } = await import("../../../../src/engine/copilot/adapter.js");

const expertA: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

function createMockModelInfo(id: string): MockModelInfo {
  return { id, name: id, capabilities: {} };
}

function resetMockState(): void {
  mockState.started = false;
  mockState.stopped = false;
  mockState.sessions = [];
  mockState.sessionInstances = [];
  mockState.sendQueues.clear();
  mockState.sendErrors.clear();
  mockState.listModelsCalls = 0;
  mockState.listModelsResults = [];
  mockState.listModelsError = undefined;
}

describe("CopilotEngine — implements CouncilEngine", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("conforms to the CouncilEngine interface (satisfies check)", () => {
    const engine: CouncilEngine = new CopilotEngine();
    expect(typeof engine.start).toBe("function");
    expect(typeof engine.stop).toBe("function");
    expect(typeof engine.addExpert).toBe("function");
    expect(typeof engine.removeExpert).toBe("function");
    expect(typeof engine.send).toBe("function");
    expect(typeof engine.listModels).toBe("function");
  });

  it("start() starts the underlying CopilotClient", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    expect(mockState.started).toBe(true);
  });

  it("start() is idempotent", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.start();
    expect(mockState.started).toBe(true);
  });

  it("stop() stops the client and disconnects all sessions", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    await engine.stop();
    expect(mockState.stopped).toBe(true);
    expect(mockState.sessions[0]?.disconnected).toBe(true);
  });

  it("stop() is idempotent", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.stop();
    await engine.stop();
    expect(mockState.stopped).toBe(true);
  });

  it("listModels() falls back to KNOWN_MODELS before the client starts", async () => {
    const engine = new CopilotEngine();

    await expect(engine.listModels()).resolves.toEqual(KNOWN_MODELS);
    expect(mockState.listModelsCalls).toBe(0);
  });

  it("listModels() discovers models from the SDK once and caches successful results", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    mockState.listModelsResults = [
      createMockModelInfo("claude-sonnet-4.6"),
      createMockModelInfo("gpt-5.4-mini"),
    ];

    await expect(engine.listModels()).resolves.toEqual(["claude-sonnet-4.6", "gpt-5.4-mini"]);

    mockState.listModelsResults = [createMockModelInfo("claude-opus-4.7")];
    mockState.listModelsError = new Error("should not hit SDK twice");

    await expect(engine.listModels()).resolves.toEqual(["claude-sonnet-4.6", "gpt-5.4-mini"]);
    expect(mockState.listModelsCalls).toBe(1);
  });

  it("listModels() falls back to KNOWN_MODELS when SDK discovery fails", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    mockState.listModelsError = new Error("network unavailable");

    await expect(engine.listModels()).resolves.toEqual(KNOWN_MODELS);
    expect(mockState.listModelsCalls).toBe(1);
  });
});

describe("CopilotEngine — expert registration", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("addExpert() creates a session keyed by expert id", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.sessions[0]?.model).toBe(expertA.model);
  });

  it("addExpert() creates the session with an empty tool allow-list (no phantom tools)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    // Council experts must not be offered any SDK tools — document content is
    // injected directly into the prompt, so an empty allow-list prevents the
    // "I have no tools / let me check your working directory" failure mode.
    expect(mockState.sessions[0]?.availableTools).toEqual([]);
  });

  it("addExpert() throws on duplicate id", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    await expect(engine.addExpert(expertA)).rejects.toThrow(/already registered/i);
  });

  it("removeExpert() disconnects the underlying session", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    await engine.removeExpert(expertA.id);
    expect(mockState.sessions[0]?.disconnected).toBe(true);
    // can re-add same id after removal
    await expect(engine.addExpert(expertA)).resolves.toBeUndefined();
  });

  it("removeExpert() of unknown id is a no-op", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await expect(engine.removeExpert("never-existed")).resolves.toBeUndefined();
  });
});

describe("CopilotEngine — send() event translation", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("translates SDK assistant.message_delta events to message.delta", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "Hello" } },
      { kind: "assistant.message_delta", data: { deltaContent: " world" } },
    ]);
    const events = await collect(engine.send({ prompt: "hi", expertId: expertA.id }));
    const deltas = events.filter((e): e is Extract<EngineEvent, { kind: "message.delta" }> => e.kind === "message.delta");
    expect(deltas.map((d) => d.text).join("")).toBe("Hello world");
    const complete = events.find((e) => e.kind === "message.complete");
    expect(complete).toBeDefined();
  });

  it("emits message.complete with latency telemetry", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "ok" } },
    ]);
    const events = await collect(engine.send({ prompt: "x", expertId: expertA.id }));
    const complete = events.find(
      (e): e is Extract<EngineEvent, { kind: "message.complete" }> => e.kind === "message.complete",
    );
    expect(complete).toBeDefined();
    if (!complete) return;
    expect(complete.response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("translates SDK assistant.message complete-response to message.delta", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    // SDK v0.3.0 sends complete responses via assistant.message instead of streaming deltas
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message", data: { content: "Complete response text" } },
    ]);
    const events = await collect(engine.send({ prompt: "hi", expertId: expertA.id }));
    const deltas = events.filter(
      (e): e is Extract<EngineEvent, { kind: "message.delta" }> => e.kind === "message.delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => d.text).join("")).toBe("Complete response text");
    const complete = events.find((e) => e.kind === "message.complete");
    expect(complete).toBeDefined();
  });

  it("throws synchronously on send() to unknown expert", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    expect(() => engine.send({ prompt: "x", expertId: "never-registered" })).toThrow(
      /not registered/i,
    );
  });

  it("translates SDK send-throw to a terminal error event with EngineError", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    mockState.sendErrors.set("session-0", new Error("rate limit"));
    const events = await collect(engine.send({ prompt: "x", expertId: expertA.id }));
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toMatch(/PROVIDER_ERROR|RATE_LIMITED|NETWORK|INTERNAL/);
      expect(last.error.provider).toBe("copilot");
    }
  });
});

describe("CopilotEngine — cancellation", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("pre-aborted signal yields terminal ABORTED error promptly", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "would-be-streamed" } },
    ]);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      engine.send({ prompt: "x", expertId: expertA.id, signal: controller.signal }),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
      expect(last.recoverable).toBe(false);
    }
  });
});

describe("CopilotEngine — listener cleanup (#479)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("unregisters per-send SDK listeners after each successful send", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    const session = mockState.sessionInstances[0];
    expect(session).toBeDefined();
    if (!session) return;

    const baseline = session.listenerCount();
    for (let i = 0; i < 5; i++) {
      mockState.sendQueues.set("session-0", [
        { kind: "assistant.message_delta", data: { deltaContent: `chunk-${i}` } },
      ]);
      await collect(engine.send({ prompt: `p${i}`, expertId: expertA.id }));
    }
    // After every send returns, all SDK listeners registered inside #stream
    // must be unregistered. Otherwise long chats accumulate handlers (#479).
    expect(session.listenerCount()).toBe(baseline);
  });

  it("unregisters listeners even when the SDK send throws", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    const session = mockState.sessionInstances[0];
    expect(session).toBeDefined();
    if (!session) return;

    const baseline = session.listenerCount();
    mockState.sendErrors.set("session-0", new Error("rate limit"));
    for (let i = 0; i < 3; i++) {
      await collect(engine.send({ prompt: `p${i}`, expertId: expertA.id }));
    }
    expect(session.listenerCount()).toBe(baseline);
  });

  it("unregisters listeners when send is aborted mid-stream", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    const session = mockState.sessionInstances[0];
    expect(session).toBeDefined();
    if (!session) return;

    const baseline = session.listenerCount();
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      controller.abort();
      mockState.sendQueues.set("session-0", [
        { kind: "assistant.message_delta", data: { deltaContent: "x" } },
      ]);
      await collect(
        engine.send({ prompt: `p${i}`, expertId: expertA.id, signal: controller.signal }),
      );
    }
    expect(session.listenerCount()).toBe(baseline);
  });

  // Regression test for #498: PR #491 added `finally`-block listener cleanup,
  // but the existing pre-aborted test never enters #stream's listener-registration
  // path (it short-circuits on the `controller.signal.aborted` check). This test
  // aborts AFTER listeners are registered and the SDK has emitted at least one
  // delta — i.e., genuinely in-flight — and verifies the count returns to
  // baseline. Without the finally block, this would leak 4 listeners per send.
  it("unregisters listeners when abort fires in-flight after listeners are registered (#498)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    const session = mockState.sessionInstances[0];
    expect(session).toBeDefined();
    if (!session) return;

    const baseline = session.listenerCount();
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "first" } },
      { kind: "assistant.message_delta", data: { deltaContent: "second" } },
      { kind: "assistant.message_delta", data: { deltaContent: "third" } },
    ]);

    const controller = new AbortController();
    const stream = engine.send({
      prompt: "stream-then-abort",
      expertId: expertA.id,
      signal: controller.signal,
    });

    let observedInFlightCount = 0;
    const events: EngineEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
      if (evt.kind === "message.delta" && !controller.signal.aborted) {
        // Listeners must be registered now — we are between SDK emissions.
        observedInFlightCount = session.listenerCount();
        controller.abort();
      }
    }

    // Sanity: we genuinely hit the in-flight path (listeners were live).
    expect(observedInFlightCount).toBeGreaterThan(baseline);

    // Stream must have terminated with ABORTED, not message.complete.
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
      expect(last.recoverable).toBe(false);
    }

    // Core assertion: finally block ran and unregistered every SDK listener.
    expect(session.listenerCount()).toBe(baseline);
  });
});

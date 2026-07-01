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

import type { CouncilEngine, EngineEvent, ExpertSpec } from "../../../../src/engine/index.js";
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
  /**
   * Per-session: a NON-Error value to throw on `send()`. Lets tests exercise
   * the adapter's `err instanceof Error ? … : String(err)` branch (#59). Uses
   * `.has()` semantics so falsy throwables (e.g. "", 0) still reject.
   */
  sendRejectRaw: Map<string, unknown>;
  listModelsCalls: number;
  listModelsResults: MockModelInfo[];
  listModelsError: Error | undefined;
  /** Number of times any session's abort() was invoked by the adapter. */
  abortCalls: number;
  /** Per-session: error to throw on `abort()` (async rejection) */
  abortErrors: Map<string, Error>;
  /** Number of times the client's stop() was invoked (re-entrancy checks). */
  stopCalls: number;
  /** Error to throw on client.stop() (async rejection), if set. */
  clientStopError: Error | undefined;
  /** When true, listModels() never resolves — exercises discovery timeout. */
  listModelsHang: boolean;
}

const mockState: MockClientState = {
  started: false,
  stopped: false,
  sessions: [],
  sessionInstances: [],
  sendQueues: new Map(),
  sendErrors: new Map(),
  sendRejectRaw: new Map(),
  listModelsCalls: 0,
  listModelsResults: [],
  listModelsError: undefined,
  abortCalls: 0,
  abortErrors: new Map(),
  stopCalls: 0,
  clientStopError: undefined,
  listModelsHang: false,
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
      if (mockState.sendRejectRaw.has(this.id)) {
        throw mockState.sendRejectRaw.get(this.id);
      }
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
    async abort(): Promise<void> {
      mockState.abortCalls += 1;
      const err = mockState.abortErrors.get(this.id);
      if (err) throw err;
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
      mockState.stopCalls += 1;
      if (mockState.clientStopError) {
        throw mockState.clientStopError;
      }
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
      if (mockState.listModelsHang) {
        await new Promise<never>(() => {
          /* never resolves — exercises the discovery timeout path */
        });
      }
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
const { CopilotEngine, discoverAvailableModels, pingProviderHealth } =
  await import("../../../../src/engine/copilot/adapter.js");

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
  mockState.sendRejectRaw.clear();
  mockState.listModelsCalls = 0;
  mockState.listModelsResults = [];
  mockState.listModelsError = undefined;
  mockState.abortCalls = 0;
  mockState.abortErrors.clear();
  mockState.stopCalls = 0;
  mockState.clientStopError = undefined;
  mockState.listModelsHang = false;
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
    const deltas = events.filter(
      (e): e is Extract<EngineEvent, { kind: "message.delta" }> => e.kind === "message.delta",
    );
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
    // The Copilot SDK may deliver a complete response via assistant.message instead of streaming deltas
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
    const thrown = new Error("rate limit exceeded (429)");
    mockState.sendErrors.set("session-0", thrown);
    const events = await collect(engine.send({ prompt: "x", expertId: expertA.id }));
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      // Pin the exact classification (was a 4-way regex that never failed) and
      // assert the original error round-trips through `cause` end-to-end (#59).
      expect(last.error.code).toBe("RATE_LIMITED");
      expect(last.error.provider).toBe("copilot");
      expect(last.error.cause).toBe(thrown);
      expect(last.recoverable).toBe(true);
    }
  });
});

describe("CopilotEngine — send-throw error classification (#59)", () => {
  beforeEach(() => {
    resetMockState();
  });

  // Drive a thrown/rejected SDK send through the adapter and return the
  // terminal error event so each branch of classifyError can be pinned
  // individually (the prior single test used a 4-way regex that never failed).
  async function terminalErrorFor(
    thrown: unknown,
    kind: "error-instance" | "raw" = "error-instance",
  ): Promise<Extract<EngineEvent, { kind: "error" }>> {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    if (kind === "raw") {
      mockState.sendRejectRaw.set("session-0", thrown);
    } else {
      mockState.sendErrors.set("session-0", thrown as Error);
    }
    const events = await collect(engine.send({ prompt: "x", expertId: expertA.id }));
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind !== "error") throw new Error("expected a terminal error event");
    return last;
  }

  it("maps abort/cancel messages to ABORTED (non-recoverable)", async () => {
    const evt = await terminalErrorFor(new Error("the request was cancelled upstream"));
    expect(evt.error.code).toBe("ABORTED");
    expect(evt.recoverable).toBe(false);
  });

  it("maps auth/login messages to NOT_AUTHENTICATED (non-recoverable)", async () => {
    const evt = await terminalErrorFor(new Error("Authentication required: please login"));
    expect(evt.error.code).toBe("NOT_AUTHENTICATED");
    expect(evt.recoverable).toBe(false);
  });

  it("maps rate/quota/limit messages to RATE_LIMITED (recoverable)", async () => {
    const evt = await terminalErrorFor(new Error("quota exceeded — rate limited"));
    expect(evt.error.code).toBe("RATE_LIMITED");
    expect(evt.recoverable).toBe(true);
  });

  it("maps model-not/unavailable messages to MODEL_UNAVAILABLE (non-recoverable)", async () => {
    const evt = await terminalErrorFor(new Error("model gpt-9 is not available on your plan"));
    expect(evt.error.code).toBe("MODEL_UNAVAILABLE");
    expect(evt.recoverable).toBe(false);
  });

  it("maps 'token limit' overflow to CONTEXT_OVERFLOW, not RATE_LIMITED (ordering) (#59)", async () => {
    // RED before the classifier reorder: the RATE_LIMITED branch's `limit`
    // keyword shadows the CONTEXT_OVERFLOW branch's `token limit` keyword.
    const evt = await terminalErrorFor(new Error("token limit exceeded"));
    expect(evt.error.code).toBe("CONTEXT_OVERFLOW");
    expect(evt.recoverable).toBe(false);
  });

  it("maps explicit context-window messages to CONTEXT_OVERFLOW", async () => {
    const evt = await terminalErrorFor(new Error("maximum context length exceeded"));
    expect(evt.error.code).toBe("CONTEXT_OVERFLOW");
  });

  it("maps network/fetch/econn messages to NETWORK (recoverable)", async () => {
    const evt = await terminalErrorFor(new Error("network unreachable: ECONNRESET"));
    expect(evt.error.code).toBe("NETWORK");
    expect(evt.recoverable).toBe(true);
  });

  it("maps unrecognized messages to PROVIDER_ERROR (non-recoverable)", async () => {
    const evt = await terminalErrorFor(new Error("teapot short and stout"));
    expect(evt.error.code).toBe("PROVIDER_ERROR");
    expect(evt.recoverable).toBe(false);
  });

  // Inverse of the ordering invariant: a pure rate-limit signal (no context /
  // token-limit keyword) must STILL classify as RATE_LIMITED after the reorder,
  // proving the fix does not over-capture generic "limit" errors.
  it("keeps pure rate-limit signals as RATE_LIMITED after the CONTEXT_OVERFLOW reorder (#59)", async () => {
    const evt = await terminalErrorFor(new Error("rate limit exceeded, retry later"));
    expect(evt.error.code).toBe("RATE_LIMITED");
  });

  it("classifies an empty SDK error message as PROVIDER_ERROR and preserves the empty message", async () => {
    const thrown = new Error("");
    const evt = await terminalErrorFor(thrown);
    expect(evt.error.code).toBe("PROVIDER_ERROR");
    expect(evt.error.message).toBe("");
    expect(evt.error.cause).toBe(thrown);
  });

  it("classifies a NON-Error throw via String(err) and round-trips it as cause (#59)", async () => {
    // The SDK may reject with a non-Error value; send() must stringify it for
    // classification yet preserve the original throwable verbatim as `cause`.
    const raw = "network blip: fetch failed";
    const evt = await terminalErrorFor(raw, "raw");
    expect(evt.error.code).toBe("NETWORK");
    expect(evt.error.message).toBe(raw);
    expect(evt.error.cause).toBe(raw);
  });

  it("preserves the original Error instance as cause for diagnostics", async () => {
    const thrown = new Error("some opaque provider failure");
    const evt = await terminalErrorFor(thrown);
    expect(evt.error.cause).toBe(thrown);
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

  it("calls session.abort() to cancel the underlying SDK request when aborted in-flight (PM-07)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    const session = mockState.sessionInstances[0];
    expect(session).toBeDefined();
    if (!session) return;

    // Multiple deltas so the abort lands genuinely in-flight (after listeners
    // are registered and at least one delta has streamed).
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

    const events: EngineEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
      if (evt.kind === "message.delta" && !controller.signal.aborted) {
        controller.abort();
      }
    }

    // Core assertion: the adapter must cancel the underlying SDK request via
    // session.abort() rather than letting it stream to completion in the
    // background after the consumer has interrupted.
    expect(mockState.abortCalls).toBeGreaterThanOrEqual(1);

    // The stream still terminates with ABORTED (existing contract preserved).
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
      expect(last.recoverable).toBe(false);
    }
  });

  // #57: three cancellation paths must all yield a terminal ABORTED. Pre-abort
  // (above) and mid-stream signal abort (PM-07, above) were already covered;
  // these pin the remaining two — stop() and removeExpert() during an in-flight
  // send — using the await-first-delta pattern from mock-engine.test.ts to
  // guarantee the teardown lands genuinely mid-stream (avoids flakes).
  it("stop() during an in-flight send yields a terminal ABORTED error (#57)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    // Multi-delta stream so there is a real window between the first delta and
    // natural completion for stop() to interrupt.
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "first" } },
      { kind: "assistant.message_delta", data: { deltaContent: "second" } },
      { kind: "assistant.message_delta", data: { deltaContent: "third" } },
      { kind: "assistant.message_delta", data: { deltaContent: "fourth" } },
    ]);

    const events: EngineEvent[] = [];
    const stream = engine.send({ prompt: "x", expertId: expertA.id });
    let resolveFirstDelta: (() => void) | undefined;
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const collectPromise = (async () => {
      for await (const evt of stream) {
        events.push(evt);
        if (evt.kind === "message.delta") resolveFirstDelta?.();
      }
    })();

    await firstDelta;
    await engine.stop();
    await collectPromise;

    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
      expect(last.error.provider).toBe("copilot");
      expect(last.recoverable).toBe(false);
    }
    // Discriminating: the underlying SDK request was actually cancelled.
    expect(mockState.abortCalls).toBeGreaterThanOrEqual(1);
  });

  it("removeExpert() during an in-flight send yields a terminal ABORTED error (#57)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "first" } },
      { kind: "assistant.message_delta", data: { deltaContent: "second" } },
      { kind: "assistant.message_delta", data: { deltaContent: "third" } },
      { kind: "assistant.message_delta", data: { deltaContent: "fourth" } },
    ]);

    const events: EngineEvent[] = [];
    const stream = engine.send({ prompt: "x", expertId: expertA.id });
    let resolveFirstDelta: (() => void) | undefined;
    const firstDelta = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const collectPromise = (async () => {
      for await (const evt of stream) {
        events.push(evt);
        if (evt.kind === "message.delta") resolveFirstDelta?.();
      }
    })();

    await firstDelta;
    await engine.removeExpert(expertA.id);
    await collectPromise;

    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
      expect(last.error.provider).toBe("copilot");
      expect(last.recoverable).toBe(false);
    }
    expect(mockState.abortCalls).toBeGreaterThanOrEqual(1);
    // The removed expert's underlying session is torn down as part of removal.
    expect(mockState.sessions[0]?.disconnected).toBe(true);
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

  it("emits a diagnostic when session.abort() rejects (F2 #1143)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);

    // Configure the mock to throw an error when abort() is called
    const abortError = new Error("session disconnected");
    mockState.abortErrors.set("session-0", abortError);

    // Prepare stream with deltas so abort is called in-flight
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "response" } },
    ]);

    // Spy on console.warn to capture diagnostic emissions
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress noisy stderr in test output
    });

    const controller = new AbortController();
    const stream = engine.send({
      prompt: "test",
      expertId: expertA.id,
      signal: controller.signal,
    });

    const events: EngineEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
      if (evt.kind === "message.delta") {
        controller.abort();
      }
    }

    // The stream still terminates with ABORTED (existing behavior preserved)
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
    }

    // Core assertion: a diagnostic must be emitted when session.abort() rejects
    expect(warnSpy).toHaveBeenCalled();
    const joined = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toMatch(/abort.*fail/i);

    warnSpy.mockRestore();
    await engine.stop();
  });
});

describe("CopilotEngine — stop() re-entrancy (#149)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("concurrent stop() calls tear down the client exactly once", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);

    // Two overlapping stop() calls must not double-iterate #experts, double-abort
    // in-flight controllers, or double-call client.stop(). The second call must
    // observe the in-flight teardown and await it rather than re-running the body.
    await Promise.all([engine.stop(), engine.stop()]);

    expect(mockState.stopCalls).toBe(1);
    expect(mockState.stopped).toBe(true);
  });

  it("stop() after a completed stop() stays a no-op", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.stop();
    await engine.stop();
    expect(mockState.stopCalls).toBe(1);
  });
});

describe("CopilotEngine — listModels() after stop() (#720)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("returns the previously discovered (cached) list after stop() when the cache was warmed (#720)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    mockState.listModelsResults = [
      createMockModelInfo("claude-sonnet-4.6"),
      createMockModelInfo("gpt-5.4-mini"),
    ];
    // Warm the cache with a live discovery, then stop the engine.
    await expect(engine.listModels()).resolves.toEqual(["claude-sonnet-4.6", "gpt-5.4-mini"]);
    await engine.stop();

    // Contract: an immutable snapshot survives stop() and no further SDK call
    // is made (a post-stop client is torn down, so re-discovery is impossible).
    await expect(engine.listModels()).resolves.toEqual(["claude-sonnet-4.6", "gpt-5.4-mini"]);
    expect(mockState.listModelsCalls).toBe(1);
  });

  it("falls back to KNOWN_MODELS after stop() when the cache was never warmed (#720)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.stop();

    // Contract: with no cached discovery and a torn-down client, listModels()
    // returns the static list rather than throwing or hitting the (gone) SDK.
    await expect(engine.listModels()).resolves.toEqual(KNOWN_MODELS);
    expect(mockState.listModelsCalls).toBe(0);
  });
});

describe("discoverAvailableModels — resilience (#719 #721 #741)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("warns and falls back to static models when discovery fails (#719)", async () => {
    mockState.listModelsError = new Error("network unavailable");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress noisy stderr in test output */
    });
    try {
      const result = await discoverAvailableModels();
      expect(result.source).toBe("static");
      expect(result.models).toEqual(KNOWN_MODELS);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toMatch(/model discovery failed/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("bounds discovery with a timeout and falls back to static models (#721)", async () => {
    mockState.listModelsHang = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress noisy stderr in test output */
    });
    try {
      const result = await discoverAvailableModels({ timeoutMs: 5 });
      expect(result.source).toBe("static");
      expect(result.models).toEqual(KNOWN_MODELS);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toMatch(/timed out/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces client.stop() cleanup failures instead of swallowing them (#741)", async () => {
    mockState.listModelsResults = [createMockModelInfo("claude-sonnet-4.6")];
    mockState.clientStopError = new Error("cleanup boom: session still open");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress noisy stderr in test output */
    });
    try {
      const result = await discoverAvailableModels();
      // Discovery itself succeeded — the failure is only in teardown, which
      // previously was swallowed silently, hiding leaked SDK sessions (#741).
      expect(result.source).toBe("live");
      expect(result.models).toEqual(["claude-sonnet-4.6"]);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toMatch(/cleanup/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still tears the client down via stop() on timeout even though the raced SDK call is uncancellable (#1899)", async () => {
    // The withTimeout() race bounds the caller's wait, but the underlying SDK
    // call keeps running (it cannot be cancelled). This pins the load-bearing
    // cleanup contract the #1899 code comment documents: the `finally` MUST
    // still invoke client.stop() so the client is torn down rather than leaked.
    mockState.listModelsHang = true;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress noisy stderr in test output */
    });
    try {
      const result = await discoverAvailableModels({ timeoutMs: 5 });
      expect(result.source).toBe("static");
      // Discriminating: teardown ran despite the still-pending SDK call.
      expect(mockState.stopCalls).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and single-lines the discovery-failure diagnostic against adversarial bytes (#719/#1899)", async () => {
    // The discovery-failure diagnostic echoes an opaque SDK error to the TTY.
    // A garbled/malicious message packed with control, C1, bidi, and line-break
    // bytes must never reach the terminal verbatim (shares sanitizeDiagnosticMessage
    // with the abort sink). Covers TAB, C0, C1 (U+009B/U+009D/U+0085), DEL, bidi,
    // CR/LF and U+2028/U+2029.
    const adversarial =
      "discovery\tboom\r\nsecond\u2028third\u2029" +
      "\u0001\u0007\u001b[31m\u009b6n\u009dtitle\u0085\u007f" +
      "\u202eRTL\u2066iso\u2069" +
      "X".repeat(400);
    mockState.listModelsError = new Error(adversarial);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress noisy stderr in test output */
    });
    try {
      const result = await discoverAvailableModels();
      expect(result.source).toBe("static");
      const prefix = "[council/engine] model discovery failed";
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith(prefix));
      expect(warned).toBeDefined();
      if (warned === undefined) return;
      // Single line: no raw CR/LF/line-separator breakout.
      expect(warned.includes("\n")).toBe(false);
      expect(warned.includes("\r")).toBe(false);
      // No control / C1 / bidi codepoints survive to the terminal.
      expect(warned).not.toMatch(
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("pingProviderHealth — export surface (#96)", () => {
  it("reports that the SDK export surface is present, not that the module is loadable", () => {
    const health = pingProviderHealth();
    expect(health.ok).toBe(true);
    // Under a static import a *load* failure aborts the module before this runs,
    // so the probe can only certify the export *surface* is present (#96).
    expect(health.detail).toMatch(/export surface/i);
  });
});

describe("CopilotEngine — abort diagnostic sanitization (#1155)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("sanitizes and length-bounds err.message in the abort-failure diagnostic against adversarial bytes (#1155/#1900)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);

    // A garbled transport error packed with every terminal-injection class:
    // TAB, C0 (NUL-adjacent + BEL), ANSI CSI, C1 (U+009B CSI, U+009D OSC,
    // U+0085 NEL), DEL, bidi override/isolate, Unicode line/paragraph
    // separators, CR/LF, and a very long tail. None may reach the TTY verbatim.
    const noisy =
      "boom\tsecond\r\nline\u2028para\u2029" +
      "\u0001\u0007\u001b[31mred\u009b6n\u009dtitle\u0085\u007f" +
      "\u202eRTL\u2066iso\u2069" +
      "A".repeat(500);
    mockState.abortErrors.set("session-0", new Error(noisy));
    mockState.sendQueues.set("session-0", [
      { kind: "assistant.message_delta", data: { deltaContent: "chunk" } },
    ]);

    const prefix = "[council/engine] session.abort() failed: ";
    let abortWarn: string | undefined;

    // #1900: install the global console.warn spy inside try/finally so a
    // mid-test throw (e.g. the stream surfacing an unexpected error) can never
    // leak the spy into sibling tests — console.warn is a module-global
    // singleton and the package vitest config sets no restoreMocks safety net.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress noisy stderr in test output */
    });
    try {
      const controller = new AbortController();
      const stream = engine.send({ prompt: "x", expertId: expertA.id, signal: controller.signal });

      const events: EngineEvent[] = [];
      for await (const evt of stream) {
        events.push(evt);
        if (evt.kind === "message.delta") {
          controller.abort();
        }
      }
      // Flush the fire-and-forget abort().catch() microtask before capturing.
      await new Promise((resolve) => setImmediate(resolve));
      abortWarn = warnSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith(prefix));
      await engine.stop();
    } finally {
      warnSpy.mockRestore();
    }

    expect(abortWarn).toBeDefined();
    if (abortWarn === undefined) return;
    // Single-line: no raw newlines / carriage returns leak through.
    expect(abortWarn.includes("\n")).toBe(false);
    expect(abortWarn.includes("\r")).toBe(false);
    // No control / C1 / bidi / line-separator codepoints survive to the terminal.
    expect(abortWarn).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
    );
    // Bounded: the message portion is capped so a huge message can't flood the
    // terminal.
    expect(abortWarn.length).toBeLessThanOrEqual(prefix.length + 200);
  });
});

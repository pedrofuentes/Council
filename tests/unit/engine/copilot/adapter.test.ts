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

// In-memory state the mock SDK manipulates so tests can introspect it.
interface MockSession {
  readonly id: string;
  readonly model: string;
  events: Record<string, unknown>[];
  disconnected: boolean;
}

interface MockClientState {
  started: boolean;
  stopped: boolean;
  sessions: MockSession[];
  /** Per-session: queue of events to emit on `send()` */
  sendQueues: Map<string, { kind: string; data: Record<string, unknown> }[]>;
  /** Per-session: error to throw on `send()` (sync) */
  sendErrors: Map<string, Error>;
}

const mockState: MockClientState = {
  started: false,
  stopped: false,
  sessions: [],
  sendQueues: new Map(),
  sendErrors: new Map(),
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
    on(event: string, handler: (evt: unknown) => void): void {
      const arr = this.handlers.get(event) ?? [];
      arr.push(handler);
      this.handlers.set(event, arr);
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
    }): Promise<MockCopilotSession> {
      const id = `session-${mockState.sessions.length}`;
      const session = new MockCopilotSession(id, opts.model);
      mockState.sessions.push({
        id,
        model: opts.model,
        events: [],
        disconnected: false,
      });
      return session;
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

describe("CopilotEngine — implements CouncilEngine", () => {
  beforeEach(() => {
    mockState.started = false;
    mockState.stopped = false;
    mockState.sessions = [];
    mockState.sendQueues.clear();
    mockState.sendErrors.clear();
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

  it("listModels() returns the configured set of models", async () => {
    const engine = new CopilotEngine();
    const models = await engine.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain("claude-sonnet-4-20250514");
  });
});

describe("CopilotEngine — expert registration", () => {
  beforeEach(() => {
    mockState.started = false;
    mockState.stopped = false;
    mockState.sessions = [];
    mockState.sendQueues.clear();
    mockState.sendErrors.clear();
  });

  it("addExpert() creates a session keyed by expert id", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    expect(mockState.sessions).toHaveLength(1);
    expect(mockState.sessions[0]?.model).toBe(expertA.model);
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
    mockState.started = false;
    mockState.stopped = false;
    mockState.sessions = [];
    mockState.sendQueues.clear();
    mockState.sendErrors.clear();
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
    mockState.started = false;
    mockState.stopped = false;
    mockState.sessions = [];
    mockState.sendQueues.clear();
    mockState.sendErrors.clear();
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

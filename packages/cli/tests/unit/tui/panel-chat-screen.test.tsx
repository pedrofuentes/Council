import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, SendOptions } from "../../../src/engine/index.js";
import * as chatEngineAdapter from "../../../src/tui/adapters/chat-engine.js";
import type {
  ChatEngineSource,
  PanelChatHandle,
} from "../../../src/tui/adapters/chat-engine-session.js";
import type { ChatSessionDataSource } from "../../../src/tui/adapters/chat-session.js";
import type { PanelsDataSource } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { PanelChatScreen } from "../../../src/tui/screens/PanelChatScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (iterations = 12): Promise<void> => {
  for (let i = 0; i < iterations; i += 1) await new Promise((r) => setImmediate(r));
};

const waitForEsc = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 140));
  await flush();
};

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

function complete(expertId: string): EngineEvent {
  return { kind: "message.complete", expertId, response: { latencyMs: 1 } };
}

function delta(expertId: string, text: string): EngineEvent {
  return { kind: "message.delta", expertId, text };
}

interface FakeSources {
  readonly chat: ChatSessionDataSource;
  readonly chatEngine: ChatEngineSource;
  readonly panels: PanelsDataSource;
  readonly openPanel: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
  readonly persistTurn: ReturnType<typeof vi.fn>;
  readonly ensureSession: ReturnType<typeof vi.fn>;
}

interface FakeOptions {
  readonly sessionId?: string;
  readonly send?: (options: SendOptions) => AsyncIterable<EngineEvent>;
  readonly route?: ChatSessionDataSource["route"];
  readonly loadHistory?: ChatSessionDataSource["loadHistory"];
  readonly loadDetail?: PanelsDataSource["loadDetail"];
}

function createSources(options: FakeOptions = {}): FakeSources {
  const close = vi.fn<[], Promise<void>>(async () => undefined);
  const send = vi.fn<[SendOptions], AsyncIterable<EngineEvent>>(
    options.send ??
      ((sendOptions) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield delta(sendOptions.expertId, `${sendOptions.expertId}:ok`);
          yield complete(sendOptions.expertId);
        },
      })),
  );
  const handle: PanelChatHandle = {
    members: [
      { slug: "cto", expertId: "expert-cto" },
      { slug: "cfo", expertId: "expert-cfo" },
    ],
    send,
    close,
  };
  const openPanel = vi.fn<[readonly string[]], Promise<PanelChatHandle>>(async () => handle);
  const persistTurn = vi.fn<Parameters<ChatSessionDataSource["persistTurn"]>, Promise<void>>(
    async () => undefined,
  );
  const ensureSession = vi.fn<
    Parameters<ChatSessionDataSource["ensureSession"]>,
    Promise<{ readonly id: string }>
  >(async () => ({ id: options.sessionId ?? "session-1" }));
  const chat: ChatSessionDataSource = {
    loadHistory:
      options.loadHistory ??
      (async () => ({
        session: options.sessionId === undefined ? undefined : { id: options.sessionId },
        turns: [],
      })),
    ensureSession,
    route:
      options.route ??
      ((input, availableSlugs) => ({
        type: input.startsWith("@") ? "mention" : "general",
        targetSlugs: input.startsWith("@cfo") ? ["cfo"] : availableSlugs,
        content: input.replace(/^@\w+\s*/, "").trim(),
      })),
    persistTurn,
  };
  const panels: PanelsDataSource = {
    loadList: async () => [],
    loadDetail:
      options.loadDetail ??
      (async () => ({
        name: "strategy[31m",
        description: "",
        source: "saved",
        members: [
          { slug: "cto", displayName: "CTO", role: "Tech", kind: "generic" },
          { slug: "cfo", displayName: "CFO", role: "Finance", kind: "generic" },
        ],
        missing: [],
      })),
  };
  return {
    chat,
    chatEngine: {
      open: async () => {
        throw new Error("unexpected expert open");
      },
      openPanel,
    },
    panels,
    openPanel,
    close,
    send,
    persistTurn,
    ensureSession,
  } as FakeSources;
}

function renderScreen(sources: Partial<FakeSources> = {}): ReturnType<typeof render> {
  const defaults = createSources();
  const value: TuiDataSources = {
    panels: sources.panels ?? defaults.panels,
    chat: sources.chat ?? defaults.chat,
    chatEngine: sources.chatEngine ?? defaults.chatEngine,
  };

  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/chat/panel/strategy"]}>
          <Routes>
            <Route path="/chat/panel/:name" element={<PanelChatScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

interface MutableNavigateProbe {
  navigate(path: string): void;
}

function NavigateProbe(props: { readonly probe: MutableNavigateProbe }): null {
  const navigate = useNavigate();
  React.useEffect(() => {
    props.probe.navigate = (path: string): void => {
      void navigate(path);
    };
  }, [navigate, props.probe]);
  return null;
}

describe("PanelChatScreen", () => {
  it("loads saved panel members and prior panel history, then opens one panel engine handle", async () => {
    const sources = createSources({
      sessionId: "session-1",
      loadHistory: async () => ({
        session: { id: "session-1" },
        turns: [
          {
            id: "u1",
            role: "user",
            expertSlug: null,
            content: "hello\nteam[31m",
            isMention: false,
          },
          { id: "e1", role: "expert", expertSlug: "cto[31m", content: "prior", isMention: false },
        ],
      }),
    });

    const { lastFrame, unmount } = renderScreen(sources);
    await flush();

    expect(sources.openPanel).toHaveBeenCalledExactlyOnceWith(["cto", "cfo"]);
    expect(lastFrame()).toContain("Panel chat strategy");
    expect(lastFrame()).toContain("You: hello team");
    expect(lastFrame()).toContain("cto: prior");
    expect(lastFrame()).not.toContain("[31m");
    unmount();
  });

  it("collapses CR / newline / line-separator injection in transcript rows", async () => {
    const sources = createSources({
      loadHistory: async () => ({
        session: { id: "session-1" },
        turns: [
          {
            id: "u1",
            role: "user",
            expertSlug: null,
            content: "safe\rSPOOF: forged-row\u2028second\nthird",
            isMention: false,
          },
        ],
      }),
    });

    const { lastFrame, unmount } = renderScreen(sources);
    await flush();

    expect(lastFrame()).toContain("You: safe SPOOF: forged-row second third");
    unmount();
  });

  it("routes a mention to only the mentioned member expert id", async () => {
    const sources = createSources();
    const { stdin, unmount } = renderScreen(sources);

    await flush();
    stdin.write("@cfo forecast");
    await flush();
    stdin.write("\r");
    await flush();

    expect(sources.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expertId: "expert-cfo", prompt: "forecast" }),
    );
    expect(sources.persistTurn).toHaveBeenCalledExactlyOnceWith("session-1", {
      userContent: "@cfo forecast",
      expertSlug: "cfo",
      expertContent: "expert-cfo:ok",
      isMention: true,
    });
    unmount();
  });

  it("fans out a general message sequentially to all panel members and persists in member order", async () => {
    const callOrder: string[] = [];
    const sources = createSources({
      send: (options) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          callOrder.push(`send:${options.expertId}`);
          yield delta(options.expertId, `answer-${options.expertId}`);
          yield complete(options.expertId);
        },
      }),
    });
    sources.persistTurn.mockImplementation(async (_sessionId, turn) => {
      callOrder.push(`persist:${turn.expertSlug}`);
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("plan");
    await flush();
    stdin.write("\r");
    await flush();

    expect(callOrder).toEqual(["send:expert-cto", "persist:cto", "send:expert-cfo", "persist:cfo"]);
    expect(lastFrame()).toContain("cto: answer-expert-cto");
    expect(lastFrame()).toContain("cfo: answer-expert-cfo");
    unmount();
  });

  it("blocks a second submitted turn while a fan-out sequence is streaming", async () => {
    const gate = deferred();
    const sources = createSources({
      send: (options) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield delta(options.expertId, "partial");
          await gate.promise;
          yield complete(options.expertId);
        },
      }),
    });
    const { stdin, unmount } = renderScreen(sources);

    await flush();
    stdin.write("first");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("second");
    await flush();
    stdin.write("\r");
    await flush();

    expect(sources.send).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
    unmount();
  });

  it("aborts streaming Esc without navigating to the back-stack route", async () => {
    const observedSignals: AbortSignal[] = [];
    const sources = createSources({
      send: (options) => {
        if (options.signal !== undefined) observedSignals.push(options.signal);
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
            yield delta(options.expertId, "waiting");
            await new Promise<void>(() => undefined);
          },
        };
      },
    });
    const value: TuiDataSources = {
      panels: sources.panels,
      chat: sources.chat,
      chatEngine: sources.chatEngine,
    };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/back", "/chat/panel/strategy"]} initialIndex={1}>
            <Routes>
              <Route path="/back" element={<Text>BACK ROUTE</Text>} />
              <Route
                path="/chat/panel/:name"
                element={<PanelChatScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("cancel navigation");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("");
    await waitForEsc();

    expect(observedSignals[0]?.aborted).toBe(true);
    expect(lastFrame()).toContain("Panel chat strategy");
    expect(lastFrame()).not.toContain("BACK ROUTE");
    expect(sources.persistTurn).not.toHaveBeenCalled();
    unmount();
  });

  it("navigates back on idle Esc", async () => {
    const sources = createSources();
    const value: TuiDataSources = {
      panels: sources.panels,
      chat: sources.chat,
      chatEngine: sources.chatEngine,
    };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels", "/chat/panel/strategy"]} initialIndex={1}>
            <Routes>
              <Route path="/panels" element={<Text>PANELS LIST</Text>} />
              <Route
                path="/chat/panel/:name"
                element={<PanelChatScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("");
    await waitForEsc();

    expect(lastFrame()).toContain("PANELS LIST");
    unmount();
  });

  it("does not persist a completed panel turn when ensureSession resolves after unmount", async () => {
    const ensureGate = deferred();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sources = createSources();
    const chat: ChatSessionDataSource = {
      ...sources.chat,
      ensureSession: vi.fn<
        Parameters<ChatSessionDataSource["ensureSession"]>,
        Promise<{ readonly id: string }>
      >(async () => {
        await ensureGate.promise;
        return { id: "late-session" };
      }),
    };
    const { stdin, unmount } = renderScreen({ ...sources, chat });

    await flush();
    stdin.write("persist late");
    await flush();
    stdin.write("\r");
    await flush();
    unmount();
    ensureGate.resolve();
    await flush();

    expect(chat.persistTurn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not update transcript when panel history resolves after unmount", async () => {
    const gate = deferred();
    let didUnmount = false;
    const transcriptSetAfterUnmount = vi.fn<[], undefined>(() => undefined);
    const originalUseState: typeof React.useState = React.useState;
    const useStateSpy = vi.spyOn(React, "useState");
    useStateSpy.mockImplementation(
      <S,>(initialState: S | (() => S)): [S, React.Dispatch<React.SetStateAction<S>>] => {
        const [state, setState] = originalUseState(initialState);
        if (Array.isArray(initialState)) {
          const wrappedSetState: React.Dispatch<React.SetStateAction<S>> = (value) => {
            if (didUnmount) transcriptSetAfterUnmount();
            setState(value);
          };
          return [state, wrappedSetState];
        }
        return [state, setState];
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sources = createSources({
      loadHistory: async () => {
        await gate.promise;
        return {
          session: { id: "late-session" },
          turns: [
            {
              id: "late-turn",
              role: "expert",
              expertSlug: "cto",
              content: "late history",
              isMention: false,
            },
          ],
        };
      },
    });

    const { unmount } = renderScreen(sources);
    await flush();
    didUnmount = true;
    unmount();
    gate.resolve();
    await flush();

    expect(sources.close).toHaveBeenCalledTimes(1);
    expect(transcriptSetAfterUnmount).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    useStateSpy.mockRestore();
  });

  it("does not persist a stale completed turn after moving to a new panel route context", async () => {
    const ensureGate = deferred();
    const probe: MutableNavigateProbe = { navigate: () => undefined };
    const persistTurn = vi.fn<Parameters<ChatSessionDataSource["persistTurn"]>, Promise<void>>(
      async () => undefined,
    );
    const sources = createSources();
    const chat: ChatSessionDataSource = {
      ...sources.chat,
      loadHistory: async (_targetType, targetSlug) => ({
        session: targetSlug === "ops" ? { id: "session-ops" } : undefined,
        turns:
          targetSlug === "ops"
            ? [
                {
                  id: "ops-prior",
                  role: "expert",
                  expertSlug: "cto",
                  content: "new panel",
                  isMention: false,
                },
              ]
            : [],
      }),
      ensureSession: vi.fn<
        Parameters<ChatSessionDataSource["ensureSession"]>,
        Promise<{ readonly id: string }>
      >(async () => {
        await ensureGate.promise;
        return { id: "session-strategy-created" };
      }),
      persistTurn,
    };
    const panels: PanelsDataSource = {
      loadList: async () => [],
      loadDetail: async (name) => ({
        name,
        description: "",
        source: "saved",
        members: [{ slug: "cto", displayName: "CTO", role: "Tech", kind: "generic" }],
        missing: [],
      }),
    };
    const value: TuiDataSources = { panels, chat, chatEngine: sources.chatEngine };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/chat/panel/strategy"]}>
            <NavigateProbe probe={probe} />
            <Routes>
              <Route
                path="/chat/panel/:name"
                element={<PanelChatScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("slow old turn");
    await flush();
    stdin.write("\r");
    await flush();
    probe.navigate("/chat/panel/ops");
    await flush();

    expect(lastFrame()).toContain("Panel chat ops");
    expect(lastFrame()).toContain("cto: new panel");

    ensureGate.resolve();
    await flush();

    expect(persistTurn).not.toHaveBeenCalledWith(
      "session-strategy-created",
      expect.objectContaining({ userContent: "slow old turn" }),
    );
    unmount();
  });

  it("closes an opened panel handle when history loading fails", async () => {
    const sources = createSources({
      loadHistory: async () => {
        throw new Error("history failed[31m");
      },
    });
    const { lastFrame, unmount } = renderScreen(sources);
    await flush();

    expect(sources.close).toHaveBeenCalledTimes(1);
    expect(sources.openPanel).toHaveBeenCalledExactlyOnceWith(["cto", "cfo"]);
    expect(lastFrame()).toContain("history failed");
    expect(lastFrame()).not.toContain("[31m");
    unmount();
  });

  it("shows a sanitized deferred notice for convene directives", async () => {
    const sources = createSources({
      route: () => ({ type: "convene", targetSlugs: [], content: "topic" }),
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("@convene topic");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("convene from chat is coming in 9.8");
    expect(sources.send).not.toHaveBeenCalled();
    expect(sources.persistTurn).not.toHaveBeenCalled();
    unmount();
  });

  it("shows a sanitized error when routing throws on malformed input", async () => {
    const sources = createSources({
      route: () => {
        throw new Error("Unknown expert: ghost\rINJECT");
      },
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("@ghost hi");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("Unknown expert: ghost INJECT");
    expect(sources.send).not.toHaveBeenCalled();
    unmount();
  });

  it("never updates the transcript from a stream delta delivered after unmount", async () => {
    let capturedOnDelta: ((chunk: string) => void) | undefined;
    const streamTurnSpy = vi
      .spyOn(chatEngineAdapter, "streamTurn")
      .mockImplementation((_send, _input, onDelta) => {
        capturedOnDelta = onDelta;
        return new Promise<chatEngineAdapter.StreamTurnResult>(() => undefined);
      });
    let didUnmount = false;
    const setAfterUnmount = vi.fn<[], undefined>(() => undefined);
    const originalUseState: typeof React.useState = React.useState;
    const useStateSpy = vi.spyOn(React, "useState");
    useStateSpy.mockImplementation(
      <S,>(initialState: S | (() => S)): [S, React.Dispatch<React.SetStateAction<S>>] => {
        const [state, setState] = originalUseState(initialState);
        if (Array.isArray(initialState)) {
          const wrapped: React.Dispatch<React.SetStateAction<S>> = (value) => {
            if (didUnmount) setAfterUnmount();
            setState(value);
          };
          return [state, wrapped];
        }
        return [state, setState];
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sources = createSources();
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("hello");
    await flush();
    stdin.write("\r");
    await flush();

    expect(capturedOnDelta).toBeDefined();
    capturedOnDelta?.("early");
    await flush();
    expect(lastFrame()).toContain("cto: early");

    didUnmount = true;
    unmount();
    capturedOnDelta?.("late");
    await flush();

    expect(setAfterUnmount).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    streamTurnSpy.mockRestore();
    useStateSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("halts the entire fan-out on Esc and never starts a later expert's turn", async () => {
    const streamTurnSpy = vi.spyOn(chatEngineAdapter, "streamTurn");
    const observedSignals: AbortSignal[] = [];
    const sources = createSources({
      send: (options) => {
        if (options.signal !== undefined) observedSignals.push(options.signal);
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
            yield delta(options.expertId, "partial");
            await new Promise<void>(() => undefined);
          },
        };
      },
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("plan");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\u001B");
    await waitForEsc();

    const startedExpertIds = streamTurnSpy.mock.calls.map((call) => call[1].expertId);
    expect(startedExpertIds).toEqual(["expert-cto"]);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(sources.send).toHaveBeenCalledTimes(1);
    expect(sources.persistTurn).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Panel chat strategy");
    streamTurnSpy.mockRestore();
    unmount();
  });

  it("reports sanitized unavailable state when panel chat sources are missing", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
    } as TuiDataSources;
    const { lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/chat/panel/strategy"]}>
            <Routes>
              <Route
                path="/chat/panel/:name"
                element={<PanelChatScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("panel chat unavailable");
    unmount();
  });
});

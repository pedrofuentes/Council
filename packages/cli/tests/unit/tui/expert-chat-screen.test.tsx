import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, SendOptions } from "../../../src/engine/index.js";
import type {
  ChatEngineHandle,
  ChatEngineSource,
} from "../../../src/tui/adapters/chat-engine-session.js";
import type { ChatSessionDataSource } from "../../../src/tui/adapters/chat-session.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ExpertChatScreen } from "../../../src/tui/screens/ExpertChatScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (iterations = 10): Promise<void> => {
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

function complete(): EngineEvent {
  return { kind: "message.complete", expertId: "expert-ulid", response: { latencyMs: 1 } };
}

function delta(text: string): EngineEvent {
  return { kind: "message.delta", expertId: "expert-ulid", text };
}

function fatal(message: string): EngineEvent {
  return {
    kind: "error",
    expertId: "expert-ulid",
    error: { code: "PROVIDER_ERROR", message },
    recoverable: false,
  };
}

interface FakeSources {
  readonly chat: ChatSessionDataSource;
  readonly chatEngine: ChatEngineSource;
  readonly open: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
  readonly persistTurn: ReturnType<typeof vi.fn>;
  readonly ensureSession: ReturnType<typeof vi.fn>;
}

interface FakeOptions {
  readonly turns?: ChatSessionDataSource["loadHistory"] extends (
    targetType: "expert",
    targetSlug: string,
  ) => Promise<infer R>
    ? R["turns"]
    : never;
  readonly sessionId?: string;
  readonly send?: (options: SendOptions) => AsyncIterable<EngineEvent>;
}

function createSources(options: FakeOptions = {}): FakeSources {
  const close = vi.fn<[], Promise<void>>(async () => undefined);
  const send = vi.fn<[SendOptions], AsyncIterable<EngineEvent>>(
    options.send ??
      (() => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield delta("ok");
          yield complete();
        },
      })),
  );
  const handle: ChatEngineHandle = {
    expertId: "expert-ulid",
    send,
    close,
  };
  const open = vi.fn<[string], Promise<ChatEngineHandle>>(async () => handle);
  const persistTurn = vi.fn<Parameters<ChatSessionDataSource["persistTurn"]>, Promise<void>>(
    async () => undefined,
  );
  const ensureSession = vi.fn<
    Parameters<ChatSessionDataSource["ensureSession"]>,
    Promise<{ id: string }>
  >(async () => ({ id: options.sessionId ?? "session-1" }));
  const chat: ChatSessionDataSource = {
    loadHistory: async () => ({
      session: options.sessionId === undefined ? undefined : { id: options.sessionId },
      turns: options.turns ?? [],
    }),
    ensureSession,
    route: (input) => ({ type: "general", targetSlugs: [], content: input.trim() }),
    persistTurn,
  };
  return {
    chat,
    chatEngine: { open },
    open,
    close,
    send,
    persistTurn,
    ensureSession,
  };
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

function renderScreen(sources: Partial<FakeSources> = {}): ReturnType<typeof render> {
  const defaults = createSources();
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    chat: sources.chat ?? defaults.chat,
    chatEngine: sources.chatEngine ?? defaults.chatEngine,
  } as TuiDataSources;

  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/chat/expert/cto"]}>
          <Routes>
            <Route
              path="/chat/expert/:slug"
              element={<ExpertChatScreen theme={theme} isActive />}
            />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("ExpertChatScreen", () => {
  it("loads prior turns on mount and opens the engine for the route slug", async () => {
    const sources = createSources({
      sessionId: "session-1",
      turns: [
        {
          id: "u1",
          role: "user",
          expertSlug: null,
          content: "hello\nthere\u001B[31m",
          isMention: false,
        },
        {
          id: "e1",
          role: "expert",
          expertSlug: "cto\u001B[31m",
          content: "prior answer",
          isMention: false,
        },
      ],
    });

    const { lastFrame, unmount } = renderScreen(sources);
    await flush();

    expect(sources.open).toHaveBeenCalledExactlyOnceWith("cto");
    expect(lastFrame()).toContain("You: hello\nthere");
    expect(lastFrame()).toContain("cto: prior answer");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("closes an opened engine handle when history loading fails", async () => {
    const close = vi.fn<[], Promise<void>>(async () => undefined);
    const handle: ChatEngineHandle = {
      expertId: "expert-ulid",
      send: vi.fn<[SendOptions], AsyncIterable<EngineEvent>>(),
      close,
    };
    const open = vi.fn<[string], Promise<ChatEngineHandle>>(async () => handle);
    const chat: ChatSessionDataSource = {
      loadHistory: async () => {
        throw new Error("history failed[31m");
      },
      ensureSession: vi.fn<
        Parameters<ChatSessionDataSource["ensureSession"]>,
        Promise<{ id: string }>
      >(async () => ({ id: "session-1" })),
      route: (input) => ({ type: "general", targetSlugs: [], content: input.trim() }),
      persistTurn: vi.fn<Parameters<ChatSessionDataSource["persistTurn"]>, Promise<void>>(
        async () => undefined,
      ),
    };

    const { lastFrame, unmount } = renderScreen({ chat, chatEngine: { open } });
    await flush();

    expect(open).toHaveBeenCalledExactlyOnceWith("cto");
    expect(close).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("history failed");
    expect(lastFrame()).not.toContain("[31m");
    unmount();
  });

  it("does not persist a completed turn after moving to a new route context", async () => {
    const ensureGate = deferred();
    const probe: MutableNavigateProbe = { navigate: () => undefined };
    const send = vi.fn<[SendOptions], AsyncIterable<EngineEvent>>(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
        yield delta("old answer");
        yield complete();
      },
    }));
    const close = vi.fn<[], Promise<void>>(async () => undefined);
    const open = vi.fn<[string], Promise<ChatEngineHandle>>(async (targetSlug) => ({
      expertId: `expert-${targetSlug}`,
      send,
      close,
    }));
    const persistTurn = vi.fn<Parameters<ChatSessionDataSource["persistTurn"]>, Promise<void>>(
      async () => undefined,
    );
    const chat: ChatSessionDataSource = {
      loadHistory: async (_targetType, targetSlug) => ({
        session: targetSlug === "cfo" ? { id: "session-cfo" } : undefined,
        turns:
          targetSlug === "cfo"
            ? [
                {
                  id: "cfo-prior",
                  role: "expert",
                  expertSlug: "cfo",
                  content: "new context answer",
                  isMention: false,
                },
              ]
            : [],
      }),
      ensureSession: vi.fn<
        Parameters<ChatSessionDataSource["ensureSession"]>,
        Promise<{ id: string }>
      >(async () => {
        await ensureGate.promise;
        return { id: "session-cto-created" };
      }),
      route: (input) => ({ type: "general", targetSlugs: [], content: input.trim() }),
      persistTurn,
    };
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      chat,
      chatEngine: { open },
    } as TuiDataSources;
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/chat/expert/cto"]}>
            <NavigateProbe probe={probe} />
            <Routes>
              <Route
                path="/chat/expert/:slug"
                element={<ExpertChatScreen theme={theme} isActive />}
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
    probe.navigate("/chat/expert/cfo");
    await flush();

    expect(lastFrame()).toContain("Chat with cfo");
    expect(lastFrame()).toContain("cfo: new context answer");

    ensureGate.resolve();
    await flush();

    expect(lastFrame()).toContain("Chat with cfo");
    expect(lastFrame()).toContain("cfo: new context answer");
    expect(persistTurn).not.toHaveBeenCalledWith("session-cto-created", {
      userContent: "slow old turn",
      expertSlug: "cto",
      expertContent: "old answer",
      isMention: false,
    });
    unmount();
  });

  it("aborts streaming Esc without navigating to the back-stack route", async () => {
    const observedSignals: AbortSignal[] = [];
    const sources = createSources({
      send: (options) => {
        if (options.signal !== undefined) observedSignals.push(options.signal);
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
            yield delta("waiting");
            await new Promise<void>(() => undefined);
          },
        };
      },
    });
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      chat: sources.chat,
      chatEngine: sources.chatEngine,
    } as TuiDataSources;
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/back", "/chat/expert/x"]} initialIndex={1}>
            <Routes>
              <Route path="/back" element={<Text>BACK ROUTE</Text>} />
              <Route
                path="/chat/expert/:slug"
                element={<ExpertChatScreen theme={theme} isActive />}
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
    expect(lastFrame()).toContain("Chat with x");
    expect(lastFrame()).toContain("waiting");
    expect(lastFrame()).not.toContain("BACK ROUTE");
    unmount();
  });

  it("does not persist a completed turn when ensureSession resolves after unmount", async () => {
    const ensureGate = deferred();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sources = createSources({
      send: () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield delta("done");
          yield complete();
        },
      }),
    });
    const chat: ChatSessionDataSource = {
      ...sources.chat,
      loadHistory: async () => ({ session: undefined, turns: [] }),
      ensureSession: vi.fn<
        Parameters<ChatSessionDataSource["ensureSession"]>,
        Promise<{ id: string }>
      >(async () => {
        await ensureGate.promise;
        return { id: "late-session" };
      }),
    };
    const { stdin, unmount } = renderScreen({ chat, chatEngine: sources.chatEngine });

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

  it("does not update transcript when history resolves after unmount", async () => {
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
    const sources = createSources();
    const chat: ChatSessionDataSource = {
      ...sources.chat,
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
    };

    const { unmount } = renderScreen({ chat, chatEngine: sources.chatEngine });
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

  it("streams a submitted prompt token-by-token and persists only after completion", async () => {
    const gate = deferred();
    const sources = createSources({
      send: () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield delta("hel");
          await gate.promise;
          yield delta("lo");
          yield complete();
        },
      }),
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("Hi there");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("You: Hi there");
    expect(lastFrame()).toContain("cto: hel");
    expect(lastFrame()).not.toContain("cto: hello");
    expect(sources.persistTurn).not.toHaveBeenCalled();

    gate.resolve();
    await flush();

    expect(lastFrame()).toContain("cto: hello");
    expect(sources.ensureSession).toHaveBeenCalledWith("expert", "cto");
    expect(sources.persistTurn).toHaveBeenCalledExactlyOnceWith("session-1", {
      userContent: "Hi there",
      expertSlug: "cto",
      expertContent: "hello",
      isMention: false,
    });
    unmount();
  });

  it("blocks a second submitted turn while streaming is in flight", async () => {
    const gate = deferred();
    const sources = createSources({
      send: () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield delta("partial");
          await gate.promise;
          yield complete();
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

  it("aborts the in-flight turn on Esc without persisting and stays on the chat route", async () => {
    const observedSignals: AbortSignal[] = [];
    const sources = createSources({
      send: (options) => {
        if (options.signal !== undefined) observedSignals.push(options.signal);
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
            yield delta("partial");
            await new Promise<void>(() => undefined);
          },
        };
      },
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("cancel me");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\u001B");
    await waitForEsc();

    expect(observedSignals[0]?.aborted).toBe(true);
    expect(sources.persistTurn).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Chat with cto");
    expect(lastFrame()).toContain("partial");
    unmount();
  });

  it("navigates back on idle Esc", async () => {
    const sources = createSources();
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      chat: sources.chat,
      chatEngine: sources.chatEngine,
    } as TuiDataSources;
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/experts", "/chat/expert/cto"]} initialIndex={1}>
            <Routes>
              <Route path="/experts" element={<Text>EXPERTS LIST</Text>} />
              <Route
                path="/chat/expert/:slug"
                element={<ExpertChatScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("\u001B");
    await waitForEsc();

    expect(lastFrame()).toContain("EXPERTS LIST");
    unmount();
  });

  it("closes the engine handle and skips post-await state updates after unmount", async () => {
    const gate = deferred();
    const sources = createSources({
      send: () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          await gate.promise;
          yield delta("late");
          yield complete();
        },
      }),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { stdin, unmount } = renderScreen(sources);

    await flush();
    stdin.write("slow");
    await flush();
    stdin.write("\r");
    await flush();
    unmount();
    gate.resolve();
    await flush();

    expect(sources.close).toHaveBeenCalledTimes(1);
    expect(sources.persistTurn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("renders a sanitized inline error for a non-abort stream failure", async () => {
    const sources = createSources({
      send: () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
          yield fatal("bad\u001B[31m\nnews");
        },
      }),
    });
    const { stdin, lastFrame, unmount } = renderScreen(sources);

    await flush();
    stdin.write("fail please");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("Stream failed: bad news");
    expect(lastFrame()).not.toContain("\u001B[31m");
    expect(sources.persistTurn).not.toHaveBeenCalled();
    unmount();
  });

  it("reports sanitized unavailable state when chat sources are missing", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
    } as TuiDataSources;
    const { lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/chat/expert/cto"]}>
            <Routes>
              <Route
                path="/chat/expert/:slug"
                element={<ExpertChatScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("chat unavailable");
    unmount();
  });
});

import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, SendOptions } from "../../../src/engine/index.js";
import { streamTurn, type ChatSendFn } from "../../../src/tui/adapters/chat-engine.js";

const expertId = "expert-1";

interface ScriptedSendOptions {
  readonly events: readonly EngineEvent[];
  readonly beforeEvent?: (index: number) => void;
  readonly onOptions?: (options: SendOptions) => void;
}

function createScriptedSend(options: ScriptedSendOptions): ChatSendFn {
  return (sendOptions: SendOptions): AsyncIterable<EngineEvent> => {
    options.onOptions?.(sendOptions);

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
        for (const [index, event] of options.events.entries()) {
          options.beforeEvent?.(index);
          yield event;
        }
      },
    };
  };
}

function delta(text: string): EngineEvent {
  return { kind: "message.delta", expertId, text };
}

function complete(): EngineEvent {
  return { kind: "message.complete", expertId, response: { latencyMs: 1 } };
}

function error(
  code: EngineEvent & { readonly kind: "error" }["error"]["code"],
  message: string,
): EngineEvent {
  return {
    kind: "error",
    expertId,
    error: { code, message },
    recoverable: code !== "ABORTED",
  };
}

describe("streamTurn", () => {
  it("assembles streamed deltas, calls onDelta for each chunk, and omits an undefined signal", async () => {
    const seenOptions: SendOptions[] = [];
    const send = createScriptedSend({
      events: [delta("hel"), delta("lo"), complete()],
      onOptions: (options) => seenOptions.push(options),
    });
    const onDelta = vi.fn<(chunk: string) => void>();

    await expect(streamTurn(send, { expertId, prompt: "say hello" }, onDelta)).resolves.toEqual({
      text: "hello",
      aborted: false,
    });

    expect(onDelta).toHaveBeenNthCalledWith(1, "hel");
    expect(onDelta).toHaveBeenNthCalledWith(2, "lo");
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(seenOptions).toEqual([{ expertId, prompt: "say hello" }]);
    expect(seenOptions[0]).not.toHaveProperty("signal");
  });

  it("treats a terminal ABORTED error as an aborted turn when the signal has fired", async () => {
    const controller = new AbortController();
    const seenOptions: SendOptions[] = [];
    const send = createScriptedSend({
      events: [delta("partial"), error("ABORTED", "stopped")],
      beforeEvent: (index) => {
        if (index === 1) {
          controller.abort();
        }
      },
      onOptions: (options) => seenOptions.push(options),
    });
    const onDelta = vi.fn<(chunk: string) => void>();

    await expect(
      streamTurn(send, { expertId, prompt: "stop", signal: controller.signal }, onDelta),
    ).resolves.toEqual({ text: "partial", aborted: true });

    expect(onDelta).toHaveBeenCalledExactlyOnceWith("partial");
    expect(seenOptions).toEqual([{ expertId, prompt: "stop", signal: controller.signal }]);
  });

  it("treats an ABORTED engine error as non-fatal even when no signal is supplied", async () => {
    const send = createScriptedSend({ events: [delta("partial"), error("ABORTED", "stopped")] });
    const onDelta = vi.fn<(chunk: string) => void>();

    await expect(streamTurn(send, { expertId, prompt: "stop" }, onDelta)).resolves.toEqual({
      text: "partial",
      aborted: false,
    });

    expect(onDelta).toHaveBeenCalledExactlyOnceWith("partial");
  });

  it("does not invoke send for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn<ChatSendFn>(createScriptedSend({ events: [delta("ignored"), complete()] }));
    const onDelta = vi.fn<(chunk: string) => void>();

    await expect(
      streamTurn(send, { expertId, prompt: "already stopped", signal: controller.signal }, onDelta),
    ).resolves.toEqual({ text: "", aborted: true });

    expect(send).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("prefers abort over a simultaneous non-abort error once the signal has fired", async () => {
    const controller = new AbortController();
    const send = createScriptedSend({
      events: [delta("partial"), error("PROVIDER_ERROR", "late failure")],
      beforeEvent: (index) => {
        if (index === 1) {
          controller.abort();
        }
      },
    });
    const onDelta = vi.fn<(chunk: string) => void>();

    await expect(
      streamTurn(send, { expertId, prompt: "stop", signal: controller.signal }, onDelta),
    ).resolves.toEqual({ text: "partial", aborted: true });
  });

  it("throws a sanitized Error for a non-abort stream error after preserving raw deltas", async () => {
    const send = createScriptedSend({
      events: [delta("raw\u001b[31m\nchunk"), error("PROVIDER_ERROR", "bad\u001b[31m\nnews")],
    });
    const onDelta = vi.fn<(chunk: string) => void>();

    await expect(streamTurn(send, { expertId, prompt: "fail" }, onDelta)).rejects.toThrow(
      new Error("bad news"),
    );

    expect(onDelta).toHaveBeenCalledExactlyOnceWith("raw\u001b[31m\nchunk");
  });
});

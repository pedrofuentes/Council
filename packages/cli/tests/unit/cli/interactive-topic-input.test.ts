import { EventEmitter } from "node:events";
import readline from "node:readline";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateInterface } = vi.hoisted(() => ({
  mockCreateInterface: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: mockCreateInterface,
}));

import { CliUserError } from "../../../src/cli/cli-user-error.js";
import {
  promptForTopic,
  promptForTopicFromStdin,
  processKeypressStream,
  type KeypressEvent,
} from "../../../src/cli/interactive-topic-input.js";

const key = (event: Partial<KeypressEvent>): KeypressEvent => ({
  sequence: "",
  name: undefined,
  ctrl: false,
  meta: false,
  shift: false,
  ...event,
});

const char = (sequence: string): KeypressEvent => key({ sequence });
const enter = key({ sequence: "\r", name: "return" });
const altEnter = key({ sequence: "\x1b\r", name: "return", meta: true });
const ctrlJ = key({ sequence: "\n", name: "j", ctrl: true });
const ctrlC = key({ sequence: "\x03", name: "c", ctrl: true });
const ctrlD = key({ sequence: "\x04", name: "d", ctrl: true });
const backspace = key({ sequence: "\x7f", name: "backspace" });
const kittyShiftEnter = key({ sequence: "\x1b[13;2u", name: "return", shift: true });
const bracketedPasteStart = key({ sequence: "\x1b[200~" });
const bracketedPasteEnd = key({ sequence: "\x1b[201~" });
const unknownCsi = key({ sequence: "\x1b[A", name: "up" });

class MockStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  private paused = true;

  readonly setRawMode = vi.fn((enabled: boolean): this => {
    this.isRaw = enabled;
    return this;
  });

  readonly resume = vi.fn((): this => {
    this.paused = false;
    return this;
  });

  readonly pause = vi.fn((): this => {
    this.paused = true;
    return this;
  });

  readonly isPaused = vi.fn((): boolean => this.paused);

  readonly on = vi.fn(
    (eventName: string | symbol, listener: (...args: readonly unknown[]) => void): this =>
      super.on(eventName, listener),
  );

  readonly once = vi.fn(
    (eventName: string | symbol, listener: (...args: readonly unknown[]) => void): this =>
      super.once(eventName, listener),
  );

  readonly off = vi.fn(
    (eventName: string | symbol, listener: (...args: readonly unknown[]) => void): this =>
      super.off(eventName, listener),
  );

  readonly removeListener = vi.fn(
    (eventName: string | symbol, listener: (...args: readonly unknown[]) => void): this =>
      super.removeListener(eventName, listener),
  );

  emitKeypress(event: KeypressEvent): boolean {
    return this.emit("keypress", event.sequence, event);
  }
}

async function* source(
  events: readonly KeypressEvent[],
): AsyncGenerator<KeypressEvent, void, void> {
  yield* events;
}

async function run(
  events: readonly KeypressEvent[],
): Promise<{ readonly result: string; readonly output: string }> {
  let output = "";
  const result = await processKeypressStream(source(events), (s) => {
    output += s;
  });
  return { result, output };
}

async function waitForKeypressListener(stdin: MockStdin): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (stdin.listenerCount("keypress") > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("keypress listener was not attached");
}

function hasUnsafeTerminalCodePoint(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x00 && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069))
  );
}

async function runPromptWithMockStdin(
  stdin: MockStdin,
  emitEvents: () => void,
): Promise<{ readonly result: string; readonly output: string }> {
  let output = "";
  const originalStdin = process.stdin;
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  const emitKeypressEvents = vi
    .spyOn(readline, "emitKeypressEvents")
    .mockImplementation(() => undefined);
  try {
    const promise = promptForTopic({
      isNonInteractiveFn: () => false,
      write: (s) => {
        output += s;
      },
    });
    await waitForKeypressListener(stdin);
    emitEvents();
    const result = await promise;
    return { result, output };
  } finally {
    emitKeypressEvents.mockRestore();
    Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
  }
}

describe("processKeypressStream", () => {
  it("submits a single-line topic with Enter", async () => {
    await expect(run([char("h"), char("i"), enter])).resolves.toMatchObject({ result: "hi" });
  });

  it("submits a non-empty topic with Ctrl+D", async () => {
    await expect(run([char("h"), char("i"), ctrlD])).resolves.toMatchObject({ result: "hi" });
  });

  it("rejects with CliUserError on Ctrl+C", async () => {
    await expect(processKeypressStream(source([ctrlC]), () => undefined)).rejects.toBeInstanceOf(
      CliUserError,
    );
  });

  it("rejects with CliUserError on Ctrl+D with an empty buffer", async () => {
    await expect(processKeypressStream(source([ctrlD]), () => undefined)).rejects.toBeInstanceOf(
      CliUserError,
    );
  });

  it("rejects with CliUserError when the stream ends before submission", async () => {
    await expect(
      processKeypressStream(source([char("h")]), () => undefined),
    ).rejects.toBeInstanceOf(CliUserError);
  });

  it("inserts a newline with Alt+Enter", async () => {
    await expect(
      run([char("h"), char("i"), altEnter, char("w"), char("o"), enter]),
    ).resolves.toMatchObject({
      result: "hi\nwo",
    });
  });

  describe("promptForTopic", () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
      mockCreateInterface.mockReset();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it("restores raw mode, bracketed paste, paused stdin state, and listeners after submit", async () => {
      const stdin = new MockStdin();
      stdin.isRaw = false;

      const { result, output } = await runPromptWithMockStdin(stdin, () => {
        stdin.emitKeypress(char("h"));
        stdin.emitKeypress(char("i"));
        stdin.emitKeypress(enter);
      });

      expect(result).toBe("hi");
      expect(stdin.resume).toHaveBeenCalledOnce();
      expect(stdin.pause).toHaveBeenCalledOnce();
      expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output).toContain("\x1b[?2004h");
      expect(output).toContain("\x1b[?2004l");
      expect(stdin.listenerCount("keypress")).toBe(0);
      expect(stdin.off).toHaveBeenCalledWith("keypress", expect.any(Function));
    });

    it("restores terminal state and listeners after Ctrl+C abort", async () => {
      const stdin = new MockStdin();
      let output = "";
      const originalStdin = process.stdin;
      Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
      const emitKeypressEvents = vi
        .spyOn(readline, "emitKeypressEvents")
        .mockImplementation(() => undefined);
      try {
        const promise = promptForTopic({
          isNonInteractiveFn: () => false,
          write: (s) => {
            output += s;
          },
        });
        await waitForKeypressListener(stdin);
        stdin.emitKeypress(ctrlC);

        await expect(promise).rejects.toBeInstanceOf(CliUserError);
      } finally {
        emitKeypressEvents.mockRestore();
        Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
      }

      expect(stdin.pause).toHaveBeenCalledOnce();
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output).toContain("\x1b[?2004l");
      expect(stdin.listenerCount("keypress")).toBe(0);
    });

    it("restores terminal state and listeners after the keypress stream throws", async () => {
      const stdin = new MockStdin();
      const failure = new Error("pty read failed");
      let output = "";

      // Unlike a source that never touches stdin, this double mirrors the real
      // keypressEventsFromStdin contract: attach a "keypress" listener while
      // iterating, and detach it in `finally` when the stream fails. Gating the
      // throw behind `failureGate` lets the test observe the listener attached
      // (non-vacuously) before triggering the failure and asserting cleanup.
      let releaseFailure: (() => void) | undefined;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });

      const failingSource: AsyncIterable<KeypressEvent> = {
        [Symbol.asyncIterator](): AsyncIterator<KeypressEvent> {
          const onKeypress = (): void => undefined;
          stdin.on("keypress", onKeypress);
          return {
            async next(): Promise<IteratorResult<KeypressEvent>> {
              try {
                await failureGate;
                throw failure;
              } finally {
                stdin.off("keypress", onKeypress);
              }
            },
          };
        },
      };

      const promise = promptForTopicFromStdin(stdin, failingSource, (s) => {
        output += s;
      });

      await waitForKeypressListener(stdin);
      expect(stdin.listenerCount("keypress")).toBeGreaterThanOrEqual(1);

      if (releaseFailure === undefined) {
        throw new Error("releaseFailure was not assigned");
      }
      releaseFailure();

      await expect(promise).rejects.toBe(failure);

      expect(stdin.pause).toHaveBeenCalledOnce();
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output).toContain("\x1b[?2004l");
      expect(stdin.listenerCount("keypress")).toBe(0);
    });

    it("preserves the cause when dumb-terminal readline fails unexpectedly", async () => {
      vi.stubEnv("TERM", "dumb");
      const failure = new Error("pty\nfailed");
      const close = vi.fn();
      let output = "";
      mockCreateInterface.mockReturnValue({
        close,
        question: vi.fn().mockRejectedValue(failure),
      });

      await expect(
        promptForTopic({
          isNonInteractiveFn: () => false,
          write: (s) => {
            output += s;
          },
        }),
      ).rejects.toMatchObject({
        message: "Topic input failed: pty failed",
        cause: failure,
      });
      expect(output).toBe("Topic input failed: pty failed\n");
      expect(close).toHaveBeenCalledOnce();
    });

    it("sanitizes dumb-terminal readline failure diagnostics before display", async () => {
      vi.stubEnv("TERM", "dumb");
      const failure = new Error(
        "pty\x1b[31m red\x1b[0m\x1b]0;pwnd\x07spoof\x00\x7f\u0081\u202E\u2028real\nline",
      );
      const close = vi.fn();
      let output = "";
      mockCreateInterface.mockReturnValue({
        close,
        question: vi.fn().mockRejectedValue(failure),
      });

      await expect(
        promptForTopic({
          isNonInteractiveFn: () => false,
          write: (s) => {
            output += s;
          },
        }),
      ).rejects.toMatchObject({
        message: "Topic input failed: pty redspoof real line",
        cause: failure,
      });
      expect(output).toBe("Topic input failed: pty redspoof real line\n");
      expect([...output.slice(0, -1)].some(hasUnsafeTerminalCodePoint)).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    });

    it("maps dumb-terminal readline AbortError to silent abort without a cause", async () => {
      vi.stubEnv("TERM", "dumb");
      const failure = new Error("operation aborted");
      failure.name = "AbortError";
      const close = vi.fn();
      let output = "";
      mockCreateInterface.mockReturnValue({
        close,
        question: vi.fn().mockRejectedValue(failure),
      });

      let thrown: unknown;
      try {
        await promptForTopic({
          isNonInteractiveFn: () => false,
          write: (s) => {
            output += s;
          },
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CliUserError);
      expect(thrown).toMatchObject({ message: "Aborted" });
      expect("cause" in (thrown as object)).toBe(false);
      expect(output).toBe("");
      expect(close).toHaveBeenCalledOnce();
    });

    it("maps dumb-terminal closed-readline errors to silent abort", async () => {
      vi.stubEnv("TERM", "dumb");
      const failure = new Error("readline was closed");
      const close = vi.fn();
      let output = "";
      mockCreateInterface.mockReturnValue({
        close,
        question: vi.fn().mockRejectedValue(failure),
      });

      await expect(
        promptForTopic({
          isNonInteractiveFn: () => false,
          write: (s) => {
            output += s;
          },
        }),
      ).rejects.toMatchObject({ message: "Aborted" });
      expect(output).toBe("");
      expect(close).toHaveBeenCalledOnce();
    });

    it("maps dumb-terminal closed-readline errors with extra message text to silent abort", async () => {
      // Pins the `.includes("readline was closed")` substring semantics: this
      // message strictly contains, but is not equal to, "readline was closed".
      // Must fail if the mapping regressed to exact-equality (`===`) matching.
      vi.stubEnv("TERM", "dumb");
      const failure = new Error("Error: readline was closed unexpectedly during prompt");
      const close = vi.fn();
      let output = "";
      mockCreateInterface.mockReturnValue({
        close,
        question: vi.fn().mockRejectedValue(failure),
      });

      let thrown: unknown;
      try {
        await promptForTopic({
          isNonInteractiveFn: () => false,
          write: (s) => {
            output += s;
          },
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CliUserError);
      expect(thrown).toMatchObject({ message: "Aborted" });
      expect("cause" in (thrown as object)).toBe(false);
      expect(output).toBe("");
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("inserts a newline with Ctrl+J", async () => {
    await expect(run([char("h"), char("i"), ctrlJ, char("w"), enter])).resolves.toMatchObject({
      result: "hi\nw",
    });
  });

  it("inserts a newline with Kitty Shift+Enter", async () => {
    await expect(run([char("h"), kittyShiftEnter, char("w"), enter])).resolves.toMatchObject({
      result: "h\nw",
    });
  });

  it("supports multiple inserted newlines", async () => {
    await expect(
      run([char("a"), altEnter, char("b"), ctrlJ, char("c"), enter]),
    ).resolves.toMatchObject({
      result: "a\nb\nc",
    });
  });

  it("backspace deletes the previous character", async () => {
    await expect(run([char("h"), char("i"), backspace, enter])).resolves.toMatchObject({
      result: "h",
    });
  });

  it("backspace at the start of a line joins with the previous line", async () => {
    await expect(
      run([char("h"), altEnter, char("w"), backspace, backspace, enter]),
    ).resolves.toMatchObject({
      result: "h",
    });
  });

  it("backspace at the very start is a no-op", async () => {
    await expect(run([backspace, char("h"), enter])).resolves.toMatchObject({ result: "h" });
  });

  it("re-prompts when Enter submits an empty buffer", async () => {
    await expect(run([enter, char("h"), char("i"), enter])).resolves.toMatchObject({
      result: "hi",
    });
  });

  it("re-prompts when submitted content is whitespace only", async () => {
    await expect(run([char(" "), char("\t"), enter, char("h"), enter])).resolves.toMatchObject({
      result: "h",
    });
  });

  it("trims trailing whitespace from the final topic", async () => {
    await expect(run([char("h"), char("i"), char(" "), enter])).resolves.toMatchObject({
      result: "hi",
    });
  });

  it("normalizes CRLF sequences to LF in the final topic", async () => {
    await expect(run([char("a\r\nb"), enter])).resolves.toMatchObject({ result: "a\nb" });
  });

  it("treats CR inside bracketed paste as an inserted newline, not submit", async () => {
    await expect(
      run([bracketedPasteStart, char("a\rb"), bracketedPasteEnd, enter]),
    ).resolves.toMatchObject({
      result: "a\nb",
    });
  });

  it("normalizes pasted CRLF inside bracketed paste", async () => {
    await expect(
      run([bracketedPasteStart, char("a\r\nb"), bracketedPasteEnd, enter]),
    ).resolves.toMatchObject({
      result: "a\nb",
    });
  });

  it("ignores unknown CSI key sequences", async () => {
    await expect(run([char("h"), unknownCsi, char("i"), enter])).resolves.toMatchObject({
      result: "hi",
    });
  });

  it("appends multibyte unicode characters", async () => {
    await expect(run([char("c"), char("afé"), char(" 🚀"), enter])).resolves.toMatchObject({
      result: "café 🚀",
    });
  });

  it("strips ANSI and OSC escapes from echoed pasted content and returned topic", async () => {
    const { output, result } = await run([
      bracketedPasteStart,
      char("safe\x1b[31m-red\x1b]0;pwnd\x07"),
      bracketedPasteEnd,
      enter,
    ]);

    expect(result).toBe("safe-red");
    expect(output).not.toContain("\x1b[31m");
    expect(output).not.toContain("\x1b]0;pwnd\x07");
    expect(output).toContain("safe-red");
  });
});

import readline from "node:readline";
import { createInterface } from "node:readline/promises";

import { CliUserError } from "./cli-user-error.js";
import { isNonInteractive } from "./non-interactive.js";
import { stripControlChars } from "./strip-control-chars.js";

export interface KeypressEvent {
  readonly sequence: string;
  readonly name: string | undefined;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface TopicInputOptions {
  readonly keypressSource?: AsyncIterable<KeypressEvent>;
  readonly write?: (s: string) => void;
  readonly isNonInteractiveFn?: () => boolean;
}

interface TopicInputStdin {
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  isPaused(): boolean;
  on(
    eventName: "keypress",
    listener: (sequence: string, key: Partial<KeypressEvent> | undefined) => void,
  ): unknown;
  once(eventName: "end" | "close", listener: () => void): unknown;
  off(
    eventName: "keypress",
    listener: (sequence: string, key: Partial<KeypressEvent> | undefined) => void,
  ): unknown;
  off(eventName: "end" | "close", listener: () => void): unknown;
}

const PROMPT = "Topic (Enter submits, Alt+Enter/Ctrl+J inserts newline): ";
const EMPTY_PROMPT = "Topic cannot be empty. Please enter a topic.\n";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const KITTY_SHIFT_ENTER = "\x1b[13;2u";

interface TopicBuffer {
  readonly lines: readonly string[];
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function cleanTopicSegment(text: string): string {
  return normalizeLineEndings(stripControlChars(text));
}

function appendText(buffer: TopicBuffer, text: string): TopicBuffer {
  const parts = text.split("\n");
  const nextLines = [...buffer.lines];
  nextLines[nextLines.length - 1] = `${nextLines[nextLines.length - 1] ?? ""}${parts[0] ?? ""}`;
  for (const part of parts.slice(1)) {
    nextLines.push(part);
  }
  return { lines: nextLines };
}

function insertNewline(buffer: TopicBuffer): TopicBuffer {
  return { lines: [...buffer.lines, ""] };
}

function backspace(buffer: TopicBuffer): TopicBuffer {
  const nextLines = [...buffer.lines];
  const lastIndex = nextLines.length - 1;
  const current = nextLines[lastIndex] ?? "";
  if (current.length > 0) {
    nextLines[lastIndex] = current.slice(0, -1);
    return { lines: nextLines };
  }
  if (nextLines.length <= 1) {
    return buffer;
  }
  nextLines.pop();
  nextLines[nextLines.length - 1] = `${nextLines[nextLines.length - 1] ?? ""}${current}`;
  return { lines: nextLines };
}

function topicFromBuffer(buffer: TopicBuffer): string {
  return cleanTopicSegment(buffer.lines.join("\n")).trim();
}

function isSubmit(event: KeypressEvent): boolean {
  return event.name === "return" && event.meta === false && event.sequence === "\r";
}

function isNewlineInsert(event: KeypressEvent): boolean {
  return (
    (event.name === "return" && event.meta === true) ||
    (event.name === "j" && event.ctrl === true) ||
    event.sequence === KITTY_SHIFT_ENTER
  );
}

function isAbort(event: KeypressEvent): boolean {
  return event.name === "c" && event.ctrl === true;
}

function isEndOfInput(event: KeypressEvent): boolean {
  return event.name === "d" && event.ctrl === true;
}

function isPrintable(event: KeypressEvent): boolean {
  return (
    event.sequence.length > 0 && !event.ctrl && !event.meta && !event.sequence.startsWith("\x1b")
  );
}

async function submitOrReprompt(
  buffer: TopicBuffer,
  write: (s: string) => void,
): Promise<string | undefined> {
  const topic = topicFromBuffer(buffer);
  if (topic.length > 0) {
    write("\n");
    return topic;
  }
  write(`\n${EMPTY_PROMPT}${PROMPT}`);
  return undefined;
}

export async function processKeypressStream(
  source: AsyncIterable<KeypressEvent>,
  write: (s: string) => void,
): Promise<string> {
  let buffer: TopicBuffer = { lines: [""] };
  let inBracketedPaste = false;
  write(PROMPT);

  for await (const event of source) {
    if (event.sequence === BRACKETED_PASTE_START) {
      inBracketedPaste = true;
      continue;
    }
    if (event.sequence === BRACKETED_PASTE_END) {
      inBracketedPaste = false;
      continue;
    }

    if (!inBracketedPaste && isAbort(event)) {
      throw new CliUserError("Aborted");
    }

    if (!inBracketedPaste && isEndOfInput(event)) {
      const topic = await submitOrReprompt(buffer, write);
      if (topic !== undefined) {
        return topic;
      }
      buffer = { lines: [""] };
      continue;
    }

    if (!inBracketedPaste && isSubmit(event)) {
      const topic = await submitOrReprompt(buffer, write);
      if (topic !== undefined) {
        return topic;
      }
      buffer = { lines: [""] };
      continue;
    }

    if (!inBracketedPaste && isNewlineInsert(event)) {
      buffer = insertNewline(buffer);
      write("\n");
      continue;
    }

    if (!inBracketedPaste && event.name === "backspace") {
      const before = buffer;
      buffer = backspace(buffer);
      if (buffer !== before) {
        write("\b \b");
      }
      continue;
    }

    if (isPrintable(event)) {
      const cleaned = cleanTopicSegment(event.sequence);
      if (cleaned.length > 0) {
        buffer = appendText(buffer, cleaned);
        write(cleaned);
      }
    }
  }

  throw new CliUserError("Aborted");
}

function keypressEventsFromStdin(stdin: TopicInputStdin): AsyncIterable<KeypressEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<KeypressEvent, void, void> {
      const queue: KeypressEvent[] = [];
      let pending: ((value: IteratorResult<KeypressEvent>) => void) | undefined;
      let done = false;

      const resolveNext = (): void => {
        const resolve = pending;
        if (resolve === undefined) {
          return;
        }
        pending = undefined;
        const event = queue.shift();
        if (event !== undefined) {
          resolve({ value: event, done: false });
        } else if (done) {
          resolve({ value: undefined, done: true });
        } else {
          pending = resolve;
        }
      };

      const onKeypress = (sequence: string, key: Partial<KeypressEvent> | undefined): void => {
        queue.push({
          sequence,
          name: key?.name,
          ctrl: key?.ctrl ?? false,
          meta: key?.meta ?? false,
          shift: key?.shift ?? false,
        });
        resolveNext();
      };
      const onEnd = (): void => {
        done = true;
        resolveNext();
      };

      stdin.on("keypress", onKeypress);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
      try {
        while (true) {
          const next = await new Promise<IteratorResult<KeypressEvent>>((resolve) => {
            const event = queue.shift();
            if (event !== undefined) {
              resolve({ value: event, done: false });
              return;
            }
            if (done) {
              resolve({ value: undefined, done: true });
              return;
            }
            pending = resolve;
          });
          if (next.done === true) {
            return;
          }
          yield next.value;
        }
      } finally {
        stdin.off("keypress", onKeypress);
        stdin.off("end", onEnd);
        stdin.off("close", onEnd);
      }
    },
  };
}

async function promptWithQuestion(write: (s: string) => void): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = await rl.question(PROMPT);
      const topic = cleanTopicSegment(answer).trim();
      if (topic.length > 0) {
        return topic;
      }
      write(EMPTY_PROMPT);
    }
  } catch (err) {
    if (isReadlineAbort(err)) {
      throw new CliUserError("Aborted");
    }
    throw new CliUserError(`Topic input failed: ${sanitizeErrorMessage(err)}`, { cause: err });
  } finally {
    rl.close();
  }
}

function isReadlineAbort(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === "AbortError" ||
    err.message === "readline was closed" ||
    err.message.includes("readline was closed")
  );
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

function shouldUseQuestionFallback(): boolean {
  return process.env.TERM === "dumb" || process.env.NO_COLOR === "dumb";
}

export async function promptForTopicFromStdin(
  stdin: TopicInputStdin,
  source: AsyncIterable<KeypressEvent>,
  write: (s: string) => void,
): Promise<string> {
  const canSetRawMode = typeof stdin.setRawMode === "function";
  const wasRaw = stdin.isRaw === true;
  const wasPaused = stdin.isPaused();

  if (canSetRawMode) {
    stdin.setRawMode?.(true);
  }
  stdin.resume();
  write("\x1b[?2004h");
  try {
    return await processKeypressStream(source, write);
  } finally {
    write("\x1b[?2004l");
    if (canSetRawMode) {
      stdin.setRawMode?.(wasRaw);
    }
    if (wasPaused) {
      stdin.pause();
    }
  }
}

export async function promptForTopic(options: TopicInputOptions = {}): Promise<string> {
  const isNonInteractiveFn = options.isNonInteractiveFn ?? isNonInteractive;
  if (isNonInteractiveFn()) {
    throw new CliUserError("No topic provided in non-interactive mode");
  }

  const write = options.write ?? ((s: string): void => void process.stderr.write(s));
  if (options.keypressSource !== undefined) {
    return processKeypressStream(options.keypressSource, write);
  }
  if (shouldUseQuestionFallback()) {
    return promptWithQuestion(write);
  }

  const stdin = process.stdin;
  readline.emitKeypressEvents(stdin);
  return promptForTopicFromStdin(stdin, keypressEventsFromStdin(stdin), write);
}

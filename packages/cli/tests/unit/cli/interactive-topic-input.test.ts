import { describe, expect, it } from "vitest";

import { CliUserError } from "../../../src/cli/cli-user-error.js";
import {
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

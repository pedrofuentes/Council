/**
 * Tests for screen reader and terminal compatibility (T-11).
 *
 * Covers:
 * - A11Y-08: Error severity text labels in ChatRenderer and PlainRenderer
 * - A11Y-09: Word-wrap attribute on Ink StreamingText
 * - A11Y-10: Force PlainRenderer for screen readers / dumb terminals / CI
 * - A11Y-11: stdin.isTTY check in chat command
 * - A11Y-12: Suppress streaming cursor for screen readers
 * - A11Y-13: TERM=dumb auto-detection (covered by A11Y-10)
 * - A11Y-14: Ink fallback on render crash
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectRenderer } from "../../../../src/cli/renderers/select.js";
import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";
import { InkRenderer } from "../../../../src/cli/renderers/ink/InkRenderer.js";
import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

// ── Helpers ──

class StringSink implements Sink {
  text = "";
  errText = "";
  write(s: string): void {
    this.text += s;
  }
  writeError(s: string): void {
    this.errText += s;
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// ── A11Y-08: Severity text labels ──

describe("A11Y-08: ChatRenderer severity text labels", () => {
  it("showSystem error includes [ERROR] text label", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSystem("something broke", "error");
    const output = stripAnsi(sink.errText);
    expect(output).toContain("[ERROR]");
  });

  it("showSystem warn includes [WARN] text label", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSystem("heads up", "warn");
    const output = stripAnsi(sink.text);
    expect(output).toContain("[WARN]");
  });

  it("showSystem info includes [INFO] text label", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSystem("fyi", "info");
    const output = stripAnsi(sink.text);
    expect(output).toContain("[INFO]");
  });
});

// ── A11Y-10 & A11Y-13: Force PlainRenderer for screen readers ──

describe("A11Y-10: selectRenderer forces PlainRenderer for accessibility", () => {
  const sink: Sink = { write: () => { /* noop */ } };
  let origTerm: string | undefined;
  let origCI: string | undefined;
  let origA11y: string | undefined;

  beforeEach(() => {
    origTerm = process.env["TERM"];
    origCI = process.env["CI"];
    origA11y = process.env["ACCESSIBILITY"];
  });

  afterEach(() => {
    if (origTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = origTerm;
    if (origCI === undefined) delete process.env["CI"];
    else process.env["CI"] = origCI;
    if (origA11y === undefined) delete process.env["ACCESSIBILITY"];
    else process.env["ACCESSIBILITY"] = origA11y;
  });

  it("returns PlainRenderer when TERM=dumb even on TTY", () => {
    process.env["TERM"] = "dumb";
    const r = selectRenderer({ format: "auto", isTTY: true, sink });
    expect(r).toBeInstanceOf(PlainRenderer);
  });

  it("returns PlainRenderer when CI=true even on TTY", () => {
    process.env["CI"] = "true";
    const r = selectRenderer({ format: "auto", isTTY: true, sink });
    expect(r).toBeInstanceOf(PlainRenderer);
  });

  it("returns PlainRenderer when CI=1 even on TTY", () => {
    process.env["CI"] = "1";
    const r = selectRenderer({ format: "auto", isTTY: true, sink });
    expect(r).toBeInstanceOf(PlainRenderer);
  });

  it("returns PlainRenderer when ACCESSIBILITY=1 even on TTY", () => {
    process.env["ACCESSIBILITY"] = "1";
    const r = selectRenderer({ format: "auto", isTTY: true, sink });
    expect(r).toBeInstanceOf(PlainRenderer);
  });

  it("still returns InkRenderer on TTY when none of those env vars set", () => {
    delete process.env["TERM"];
    delete process.env["CI"];
    delete process.env["ACCESSIBILITY"];
    const r = selectRenderer({ format: "auto", isTTY: true, sink });
    expect(r).toBeInstanceOf(InkRenderer);
  });
});

// ── A11Y-12: Suppress streaming cursor for screen readers ──

describe("A11Y-12: streaming cursor suppression", () => {
  let origNoColor: string | undefined;
  let origAscii: string | undefined;
  let origTerm: string | undefined;

  beforeEach(() => {
    origNoColor = process.env["NO_COLOR"];
    origAscii = process.env["COUNCIL_ASCII"];
    origTerm = process.env["TERM"];
  });

  afterEach(() => {
    if (origNoColor === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = origNoColor;
    if (origAscii === undefined) delete process.env["COUNCIL_ASCII"];
    else process.env["COUNCIL_ASCII"] = origAscii;
    if (origTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = origTerm;
  });

  it("shouldSuppressCursor returns true when NO_COLOR is set", async () => {
    const { shouldSuppressCursor } = await import(
      "../../../../src/cli/renderers/ink/InkRenderer.js"
    );
    process.env["NO_COLOR"] = "1";
    delete process.env["COUNCIL_ASCII"];
    delete process.env["TERM"];
    expect(shouldSuppressCursor()).toBe(true);
  });

  it("shouldSuppressCursor returns true when COUNCIL_ASCII=1", async () => {
    const { shouldSuppressCursor } = await import(
      "../../../../src/cli/renderers/ink/InkRenderer.js"
    );
    delete process.env["NO_COLOR"];
    process.env["COUNCIL_ASCII"] = "1";
    delete process.env["TERM"];
    expect(shouldSuppressCursor()).toBe(true);
  });

  it("shouldSuppressCursor returns true when TERM=dumb", async () => {
    const { shouldSuppressCursor } = await import(
      "../../../../src/cli/renderers/ink/InkRenderer.js"
    );
    delete process.env["NO_COLOR"];
    delete process.env["COUNCIL_ASCII"];
    process.env["TERM"] = "dumb";
    expect(shouldSuppressCursor()).toBe(true);
  });

  it("shouldSuppressCursor returns false when none of the env vars are set", async () => {
    const { shouldSuppressCursor } = await import(
      "../../../../src/cli/renderers/ink/InkRenderer.js"
    );
    delete process.env["NO_COLOR"];
    delete process.env["COUNCIL_ASCII"];
    process.env["TERM"] = "xterm-256color";
    expect(shouldSuppressCursor()).toBe(false);
  });
});

// ── A11Y-14: Ink fallback on render crash ──
// The full fallback test with vi.mock lives in ink/ink-fallback.test.ts.
// Here we verify the normal render path still works with the try/catch wrapper.

describe("A11Y-14: InkRenderer fallback mechanism (normal path)", () => {
  it("renders successfully and does NOT emit fallback warning under normal conditions", async () => {
    const { Writable } = await import("node:stream");
    let stderrOutput = "";
    const fakeStderr = new Writable({
      write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
        stderrOutput += chunk.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;

    const renderer = new InkRenderer({ isTTY: true, stderr: fakeStderr });
    async function* events() {
      yield {
        kind: "panel.assembled" as const,
        experts: [{ slug: "a", displayName: "A", model: "m" }],
      };
      yield { kind: "debate.end" as const, reason: "complete" as const };
    }
    await expect(renderer.render(events())).resolves.toBeUndefined();
    // Must NOT have triggered the fallback
    expect(stderrOutput).not.toContain("[WARN]");
    expect(stderrOutput).not.toContain("falling back to plain text");
  });
});

// ── A11Y-11: stdin.isTTY check ──

describe("A11Y-11: chat command stdin.isTTY check", () => {
  it("isInteractiveTerminal returns false when isTTY is false", async () => {
    const { isInteractiveTerminal } = await import(
      "../../../../src/cli/commands/chat.js"
    );
    expect(isInteractiveTerminal(false)).toBe(false);
  });

  it("isInteractiveTerminal returns true when isTTY is true", async () => {
    const { isInteractiveTerminal } = await import(
      "../../../../src/cli/commands/chat.js"
    );
    expect(isInteractiveTerminal(true)).toBe(true);
  });

  it("isInteractiveTerminal returns false when isTTY is undefined", async () => {
    const { isInteractiveTerminal } = await import(
      "../../../../src/cli/commands/chat.js"
    );
    expect(isInteractiveTerminal(undefined)).toBe(false);
  });

  it("buildChatCommand rejects with CliUserError when stdin is not a TTY", async () => {
    const { buildChatCommand } = await import(
      "../../../../src/cli/commands/chat.js"
    );
    const { CliUserError } = await import(
      "../../../../src/cli/cli-user-error.js"
    );

    // Build command without inputProvider — the TTY guard should fire
    const cmd = buildChatCommand({});

    // Save and mock process.stdin.isTTY
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      // Commander catches errors from .action() — we need to invoke the action
      // by calling parseAsync. The command will throw CliUserError before any DB/engine work.
      let caughtError: unknown;
      cmd.exitOverride(); // prevent process.exit
      try {
        await cmd.parseAsync(["node", "chat", "some-expert", "--engine", "mock"], { from: "user" });
      } catch (err: unknown) {
        caughtError = err;
      }

      // Commander wraps errors — unwrap if needed
      const actual = caughtError instanceof Error && "nestedError" in caughtError
        ? (caughtError as { nestedError: unknown }).nestedError
        : caughtError;
      expect(actual).toBeInstanceOf(CliUserError);
      expect((actual as Error).message).toContain("interactive terminal");
      expect((actual as Error).message).toContain("council ask");
    } finally {
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      } else {
        delete (process.stdin as Record<string, unknown>)["isTTY"];
      }
    }
  });
});

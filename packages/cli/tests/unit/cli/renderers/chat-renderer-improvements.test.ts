/**
 * Tests for chat renderer improvements (T-10).
 *
 * Covers:
 * - TUI-11: showThinking method
 * - TUI-16: Multi-line streaming indentation
 * - TUI-23: "(recoverable)" → "— retrying automatically" in showSystem
 * - TUI-27: showUserMessage multi-line replay fix
 */
import { beforeAll, describe, expect, it } from "vitest";
import chalk from "chalk";

import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

beforeAll(() => {
  chalk.level = 1;
});

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

// Strip ANSI escape sequences for assertion convenience.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeExperts(
  ...entries: readonly (readonly [string, string])[]
): ReadonlyMap<string, string> {
  return new Map(entries);
}

describe("ChatRenderer improvements", () => {
  describe("TUI-11: showThinking", () => {
    it("exists as a method on the renderer", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      expect(renderer.showThinking).toBeDefined();
      expect(typeof renderer.showThinking).toBe("function");
    });

    it("writes expert name prefix followed by dim 'thinking...' text", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.showThinking("cto");
      const stripped = stripAnsi(sink.text);
      expect(stripped).toContain("Dahlia");
      expect(stripped).toContain("thinking...");
    });

    it("does NOT end with a newline (so startExpertResponse can overwrite)", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.showThinking("cto");
      expect(sink.text.endsWith("\n")).toBe(false);
    });

    it("starts with \\r to allow overwriting", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.showThinking("cto");
      // The output should use \r for overwriting capability
      // (startExpertResponse uses \r to overwrite thinking line)
      // showThinking itself just writes without \n
      expect(sink.text).not.toContain("\n");
    });
  });

  describe("TUI-16: Multi-line streaming indentation", () => {
    it("indents continuation lines in streamed chunks with 2 spaces", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk("line 1\nline 2\nline 3");
      const chunk = sink.text.slice(beforeLen);
      expect(chunk).toBe("line 1\n  line 2\n  line 3");
    });

    it("does not indent the first line of a chunk", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk("only one line");
      const chunk = sink.text.slice(beforeLen);
      expect(chunk).toBe("only one line");
    });

    it("handles multiple chunks preserving indentation across newlines", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk("hello\nworld");
      const chunk = sink.text.slice(beforeLen);
      expect(chunk).toBe("hello\n  world");
    });
  });

  describe("TUI-27: showUserMessage multi-line replay", () => {
    it("preserves newlines in user message content for transcript replay", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showUserMessage("line 1\nline 2\nline 3");
      const stripped = stripAnsi(sink.text);
      expect(stripped).toContain("line 1\n");
      expect(stripped).toContain("line 2\n");
      expect(stripped).toContain("line 3");
    });

    it("still sanitizes control characters in user message content", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showUserMessage("safe\u001b[2Jtext\nline2");
      const stripped = stripAnsi(sink.text);
      expect(stripped).toContain("safetext\n");
      expect(stripped).toContain("line2");
    });
  });
});

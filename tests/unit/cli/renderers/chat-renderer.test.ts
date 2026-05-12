/**
 * Tests for the Chat renderer.
 *
 * Unlike the debate renderers (Plain/Json) that consume a DebateEvent
 * stream, the chat renderer is a utility module of imperative formatting
 * functions for the interactive `council chat` command.
 *
 * RED at this commit: src/cli/renderers/chat-renderer.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

describe("ChatRenderer", () => {
  describe("showSessionStatus", () => {
    it("writes the status message followed by a newline", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSessionStatus("Starting new conversation with Dahlia Renner (CTO)...");
      expect(stripAnsi(sink.text)).toBe("Starting new conversation with Dahlia Renner (CTO)...\n");
    });
  });

  describe("showPrompt", () => {
    it('writes "You > " without a trailing newline', () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showPrompt();
      expect(stripAnsi(sink.text)).toBe("You > ");
    });

    it("emits bold ANSI codes around the prompt", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showPrompt();
      // chalk.bold emits SGR 1 ... SGR 22
      expect(sink.text).toContain("\u001b[1m");
    });
  });

  describe("showUserMessage", () => {
    it('prefixes the message with "You > " and ends with a newline', () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showUserMessage("What about microservices?");
      expect(stripAnsi(sink.text)).toBe("You > What about microservices?\n");
    });
  });

  describe("expert response streaming", () => {
    it('starts with "<displayName> > " prefix using the assigned color', () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia (CTO)"]),
      });
      renderer.startExpertResponse("cto");
      expect(stripAnsi(sink.text)).toBe("Dahlia (CTO) > ");
    });

    it("streamChunk writes text without trailing newline", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia (CTO)"]),
      });
      renderer.startExpertResponse("cto");
      renderer.streamChunk("Microservices ");
      renderer.streamChunk("are powerful.");
      expect(stripAnsi(sink.text)).toBe("Dahlia (CTO) > Microservices are powerful.");
    });

    it("endExpertResponse adds a newline", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia (CTO)"]),
      });
      renderer.startExpertResponse("cto");
      renderer.streamChunk("hello");
      renderer.endExpertResponse();
      expect(stripAnsi(sink.text)).toBe("Dahlia (CTO) > hello\n");
    });

    it("falls back to the slug when expert is not registered", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.startExpertResponse("unknown");
      expect(stripAnsi(sink.text)).toBe("unknown > ");
    });
  });

  describe("color assignment", () => {
    it("assigns the same color to the same expert across calls", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const first = sink.text;
      sink.text = "";
      renderer.startExpertResponse("cto");
      const second = sink.text;
      expect(first).toBe(second);
    });

    it("assigns colors deterministically by registration order", () => {
      const sinkA = new StringSink();
      const sinkB = new StringSink();
      const experts = makeExperts(["cto", "Dahlia"], ["sre", "Priya"], ["pm", "Liam"]);
      const a = createChatRenderer({ sink: sinkA, experts });
      const b = createChatRenderer({ sink: sinkB, experts });
      a.startExpertResponse("sre");
      b.startExpertResponse("sre");
      expect(sinkA.text).toBe(sinkB.text);
    });

    it("assigns different colors to different experts", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"], ["sre", "Priya"]),
      });
      renderer.startExpertResponse("cto");
      const ctoOutput = sink.text;
      sink.text = "";
      renderer.startExpertResponse("sre");
      const sreOutput = sink.text;
      // ANSI codes differ even though display names differ; the codes
      // before the name must not match (first expert: cyan, second: magenta).
      const ctoCodes = ctoOutput.match(ANSI_RE) ?? [];
      const sreCodes = sreOutput.match(ANSI_RE) ?? [];
      expect(ctoCodes).not.toEqual([]);
      expect(sreCodes).not.toEqual([]);
      expect(ctoCodes[0]).not.toBe(sreCodes[0]);
    });

    it("cycles colors when there are more experts than palette entries", () => {
      const sink = new StringSink();
      const entries: (readonly [string, string])[] = [];
      for (let i = 0; i < 10; i++) entries.push([`e${i}`, `Expert${i}`]);
      const renderer = createChatRenderer({ sink, experts: new Map(entries) });
      // 9th expert (index 8) should reuse palette[0] — same color as first.
      renderer.startExpertResponse("e0");
      const first = sink.text.match(ANSI_RE)?.[0];
      sink.text = "";
      renderer.startExpertResponse("e8");
      const ninth = sink.text.match(ANSI_RE)?.[0];
      expect(ninth).toBe(first);
    });
  });

  describe("showSystem", () => {
    it("prefixes info messages with ℹ", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem("Saved.", "info");
      expect(stripAnsi(sink.text)).toBe("ℹ Saved.\n");
    });

    it("defaults level to info when omitted", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem("Saved.");
      expect(stripAnsi(sink.text)).toBe("ℹ Saved.\n");
    });

    it("prefixes warnings with ⚠", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem("Marcus could not respond.", "warn");
      expect(stripAnsi(sink.text)).toBe("⚠ Marcus could not respond.\n");
    });

    it("prefixes errors with ✗ and routes to writeError", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem("Engine failed.", "error");
      expect(stripAnsi(sink.errText)).toBe("✗ Engine failed.\n");
      expect(sink.text).toBe("");
    });
  });

  describe("showSeparator", () => {
    it("writes a dim horizontal line followed by a newline", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSeparator();
      const stripped = stripAnsi(sink.text);
      expect(stripped).toBe("─".repeat(40) + "\n");
    });
  });
});

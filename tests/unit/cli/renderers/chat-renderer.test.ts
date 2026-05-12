/**
 * Tests for the Chat renderer.
 *
 * Unlike the debate renderers (Plain/Json) that consume a DebateEvent
 * stream, the chat renderer is a utility module of imperative formatting
 * functions for the interactive `council chat` command.
 *
 * RED at this commit: src/cli/renderers/chat-renderer.ts does not exist.
 */
import { beforeAll, describe, expect, it } from "vitest";
import chalk from "chalk";

import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

// Force chalk to emit basic 16-color SGR codes regardless of the runner's
// TTY/FORCE_COLOR detection. Without this, ANSI assertions are flaky in
// CI and no-color environments.
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

/** Sink without `writeError` — exercises the stdout-fallback branch. */
class WriteOnlySink implements Sink {
  text = "";
  write(s: string): void {
    this.text += s;
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

    it("falls back to write() when the sink has no writeError method", () => {
      const sink = new WriteOnlySink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem("Engine failed.", "error");
      expect(stripAnsi(sink.text)).toBe("✗ Engine failed.\n");
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

  describe("control-character sanitization", () => {
    // Untrusted strings (model output, user input, LLM-generated displayNames)
    // must not pass raw ANSI/OSC/C0 sequences to the terminal — otherwise a
    // malicious or compromised model could spoof prompts, clear the screen,
    // or emit OSC hyperlinks. The renderer reuses stripControlChars().
    const INJECTION = "before\u001b[2J\u001b]0;evil\u0007\u0007after";

    it("strips control sequences from streamed chunks", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk(INJECTION);
      const chunk = sink.text.slice(beforeLen);
      expect(chunk).toBe("beforeafter");
    });

    it("strips control sequences from user messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showUserMessage(INJECTION);
      expect(stripAnsi(sink.text)).toBe("You > beforeafter\n");
    });

    it("strips control sequences from session status messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSessionStatus(INJECTION);
      expect(stripAnsi(sink.text)).toBe("beforeafter\n");
    });

    it("strips control sequences from system messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem(INJECTION, "warn");
      expect(stripAnsi(sink.text)).toBe("⚠ beforeafter\n");
    });

    it("strips control sequences from system error messages on stderr", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem(INJECTION, "error");
      expect(stripAnsi(sink.errText)).toBe("✗ beforeafter\n");
    });

    it("strips control sequences from expert display names", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", INJECTION]),
      });
      renderer.startExpertResponse("cto");
      expect(stripAnsi(sink.text)).toBe("beforeafter > ");
    });

    // Carriage return (\r) returns the cursor to column 0 — without
    // stripping, an attacker-controlled chunk could overwrite the current
    // line (e.g. replace "Dahlia > " with a fake "You > " prompt). The
    // shared `stripControlChars` helper preserves \r for transcript fidelity,
    // so the chat renderer must strip it locally for terminal safety.
    const CR_INJECTION = "real\rfake";

    it("strips carriage returns from streamed chunks", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk(CR_INJECTION);
      expect(sink.text.slice(beforeLen)).toBe("realfake");
    });

    it("strips carriage returns from user messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showUserMessage(CR_INJECTION);
      expect(stripAnsi(sink.text)).toBe("You > realfake\n");
    });

    it("strips carriage returns from expert display names", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", CR_INJECTION]),
      });
      renderer.startExpertResponse("cto");
      expect(stripAnsi(sink.text)).toBe("realfake > ");
    });

    it("strips carriage returns from system messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem(CR_INJECTION, "warn");
      expect(stripAnsi(sink.text)).toBe("⚠ realfake\n");
    });

    it("strips carriage returns from session status", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSessionStatus(CR_INJECTION);
      expect(stripAnsi(sink.text)).toBe("realfake\n");
    });

    it("preserves newlines in streamed chunks (multi-paragraph responses)", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk("para 1\npara 2");
      expect(sink.text.slice(beforeLen)).toBe("para 1\npara 2");
    });
  });

  describe("single-line surface newline collapsing", () => {
    // Display names, status banners, system messages and replayed user
    // input are single-line UI chrome. Without collapsing line breaks, an
    // attacker-controlled value like "Mallory\nYou > hacked" would render
    // as a fake prompt line on the next row. Newlines (and the rarer
    // Unicode line separators) must collapse to a single space.
    const NL_INJECTION = "Mallory\nYou > hacked";

    it("collapses newlines in expert display names", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", NL_INJECTION]),
      });
      renderer.startExpertResponse("cto");
      expect(stripAnsi(sink.text)).toBe("Mallory You > hacked > ");
    });

    it("collapses newlines in session status messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSessionStatus(NL_INJECTION);
      expect(stripAnsi(sink.text)).toBe("Mallory You > hacked\n");
    });

    it("collapses newlines in user message replay", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showUserMessage(NL_INJECTION);
      expect(stripAnsi(sink.text)).toBe("You > Mallory You > hacked\n");
    });

    it("collapses newlines in system messages", () => {
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem(NL_INJECTION, "warn");
      expect(stripAnsi(sink.text)).toBe("⚠ Mallory You > hacked\n");
    });

    it("collapses Unicode line separators (\\u2028, \\u2029)", () => {
      // Note: \v and \f are removed entirely by stripControlChars (they're
      // C0 controls), which is even safer than collapsing to a space.
      const sink = new StringSink();
      const renderer = createChatRenderer({ sink, experts: makeExperts() });
      renderer.showSystem("a\u2028b\u2029c", "info");
      expect(stripAnsi(sink.text)).toBe("ℹ a b c\n");
    });

    it("still preserves newlines in streamed expert response chunks", () => {
      // Regression guard: streaming surfaces (multi-line response bodies)
      // must NOT collapse newlines, only single-line UI chrome should.
      const sink = new StringSink();
      const renderer = createChatRenderer({
        sink,
        experts: makeExperts(["cto", "Dahlia"]),
      });
      renderer.startExpertResponse("cto");
      const beforeLen = sink.text.length;
      renderer.streamChunk("line 1\nline 2");
      expect(sink.text.slice(beforeLen)).toBe("line 1\nline 2");
    });
  });
});

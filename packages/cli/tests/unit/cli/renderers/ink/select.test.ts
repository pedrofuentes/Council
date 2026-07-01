/**
 * Tests for the renderer selection factory.
 *
 * The Council CLI supports three output formats:
 *   - "json"  → always NDJSON, regardless of TTY
 *   - "plain" → always plain text, regardless of TTY
 *   - "auto"  → Ink TUI on TTY, plain text otherwise
 *
 * Explicit --format flags must always override TTY auto-detection so
 * piped output and CI runs stay deterministic.
 *
 * RED at this commit: src/cli/renderers/select.ts does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectRenderer } from "../../../../../src/cli/renderers/select.js";
import { JsonRenderer } from "../../../../../src/cli/renderers/json.js";
import { PlainRenderer } from "../../../../../src/cli/renderers/plain.js";
import { InkRenderer } from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { Sink } from "../../../../../src/cli/renderers/types.js";
import type { DebateEvent } from "../../../../../src/core/types.js";

const sink: Sink = {
  write: () => {
    /* discard */
  },
};

/** Capturing sink that accumulates stdout/stderr writes for assertions. */
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

async function* eventStream(...evts: readonly DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const evt of evts) yield evt;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * A completed single-turn debate. The `debate.end` event and `isTTY: true`
 * drive InkRenderer's post-unmount plain-text transcript, which is the
 * deterministic surface these integration tests assert against.
 */
const DEBATE_EVENTS: readonly DebateEvent[] = [
  {
    kind: "panel.assembled",
    experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
  },
  { kind: "round.start", round: 0 },
  { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
  { kind: "turn.delta", expertSlug: "alice", text: "SINK_MARKER" },
  { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "SINK_MARKER" },
  { kind: "cost.update", premiumRequests: 3, estimatedTotal: 10 },
  { kind: "debate.end", reason: "completed" },
];

let originalTerm: string | undefined;
let originalCi: string | undefined;
let originalAccessibility: string | undefined;

describe("selectRenderer", () => {
  beforeEach(() => {
    originalTerm = process.env["TERM"];
    originalCi = process.env["CI"];
    originalAccessibility = process.env["ACCESSIBILITY"];
    delete process.env["TERM"];
    delete process.env["CI"];
    delete process.env["ACCESSIBILITY"];
  });

  afterEach(() => {
    if (originalTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = originalTerm;

    if (originalCi === undefined) delete process.env["CI"];
    else process.env["CI"] = originalCi;

    if (originalAccessibility === undefined) delete process.env["ACCESSIBILITY"];
    else process.env["ACCESSIBILITY"] = originalAccessibility;
  });

  it("format=json returns JsonRenderer on TTY", () => {
    expect(selectRenderer({ format: "json", isTTY: true, sink })).toBeInstanceOf(JsonRenderer);
  });

  it("format=json returns JsonRenderer off TTY", () => {
    expect(selectRenderer({ format: "json", isTTY: false, sink })).toBeInstanceOf(JsonRenderer);
  });

  it("format=plain returns PlainRenderer on TTY (override)", () => {
    expect(selectRenderer({ format: "plain", isTTY: true, sink })).toBeInstanceOf(PlainRenderer);
  });

  it("format=plain returns PlainRenderer off TTY", () => {
    expect(selectRenderer({ format: "plain", isTTY: false, sink })).toBeInstanceOf(PlainRenderer);
  });

  it("format=auto on TTY returns InkRenderer when no plain-text override is active", () => {
    expect(selectRenderer({ format: "auto", isTTY: true, sink })).toBeInstanceOf(InkRenderer);
  });

  it("format=auto on TTY returns PlainRenderer in CI", () => {
    process.env["CI"] = "1";
    expect(selectRenderer({ format: "auto", isTTY: true, sink })).toBeInstanceOf(PlainRenderer);
  });

  it("format=auto off TTY returns PlainRenderer (graceful degrade)", () => {
    expect(selectRenderer({ format: "auto", isTTY: false, sink })).toBeInstanceOf(PlainRenderer);
  });
});

/**
 * Integration tests for the auto→Ink branch: `selectRenderer` must thread the
 * injected `sink` into `InkRenderer` (#235) and forward `quiet` (#851).
 *
 * These render a completed debate and assert against the captured `sink`
 * output. `auto` is the ONLY format that constructs `InkRenderer` (there is no
 * explicit `ink` format), so the auto branch fully exercises the sink invariant.
 */
describe("selectRenderer auto→Ink integration", () => {
  let originalTerm: string | undefined;
  let originalCi: string | undefined;
  let originalAccessibility: string | undefined;

  beforeEach(() => {
    originalTerm = process.env["TERM"];
    originalCi = process.env["CI"];
    originalAccessibility = process.env["ACCESSIBILITY"];
    delete process.env["TERM"];
    delete process.env["CI"];
    delete process.env["ACCESSIBILITY"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = originalTerm;
    if (originalCi === undefined) delete process.env["CI"];
    else process.env["CI"] = originalCi;
    if (originalAccessibility === undefined) delete process.env["ACCESSIBILITY"];
    else process.env["ACCESSIBILITY"] = originalAccessibility;
  });

  it("threads the injected sink into InkRenderer (#235: output isolation)", async () => {
    const capture = new StringSink();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const renderer = selectRenderer({ format: "auto", isTTY: true, sink: capture });
    expect(renderer).toBeInstanceOf(InkRenderer);
    await renderer.render(eventStream(...DEBATE_EVENTS));

    const captured = stripAnsi(capture.text);
    // The InkRenderer output must land on the INJECTED sink...
    expect(captured).toContain("SINK_MARKER");
    // ...and must NOT leak to the real process streams.
    const leaked = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(leaked).not.toContain("SINK_MARKER");
    expect(stderrSpy.mock.calls.map((call) => String(call[0])).join("")).not.toContain(
      "SINK_MARKER",
    );
  });

  it("still writes to process.stdout when the sink targets it (#235: default path not regressed)", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Mirrors production wiring: the sink forwards to the real process streams
    // (defaultWriter / defaultErrorWriter). Output must still reach stdout.
    const passthrough: Sink = {
      write: (s) => {
        process.stdout.write(s);
      },
      writeError: (s) => {
        process.stderr.write(s);
      },
    };

    const renderer = selectRenderer({ format: "auto", isTTY: true, sink: passthrough });
    await renderer.render(eventStream(...DEBATE_EVENTS));

    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("SINK_MARKER");
  });

  it("forwards quiet=true through selectRenderer to suppress cost (#851)", async () => {
    const capture = new StringSink();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const renderer = selectRenderer({ format: "auto", isTTY: true, sink: capture, quiet: true });
    await renderer.render(eventStream(...DEBATE_EVENTS));

    const captured = stripAnsi(capture.text);
    // Content still renders...
    expect(captured).toContain("SINK_MARKER");
    // ...but the cost indicator is suppressed because quiet reached the renderer.
    expect(captured).not.toContain("Premium requests");
  });

  it("surfaces cost when quiet is unset (#851: quiet assertion discriminates)", async () => {
    const capture = new StringSink();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const renderer = selectRenderer({ format: "auto", isTTY: true, sink: capture });
    await renderer.render(eventStream(...DEBATE_EVENTS));

    const captured = stripAnsi(capture.text);
    expect(captured).toContain("SINK_MARKER");
    // Without quiet, the cost indicator IS present — so the suppression assertion
    // above genuinely distinguishes quiet=true from the default.
    expect(captured).toContain("Premium requests");
  });
});

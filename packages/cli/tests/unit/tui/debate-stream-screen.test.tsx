import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ConveneDataSource, ConveneViewEvent } from "../../../src/tui/adapters/convene.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import {
  DebateStreamScreen,
  transcriptLines,
} from "../../../src/tui/screens/DebateStreamScreen.js";
import { expertColorIndex, resolveExpertPalette } from "../../../src/tui/theme/expert-palette.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

const estimateStub: ConveneDataSource["estimateCost"] = async () => ({
  experts: 1,
  rounds: 1,
  estimatedPremiumRequests: 1,
});

function SessionProbe(): React.ReactElement {
  const params = useParams();
  const location = useLocation();
  const state = location.state as { readonly panelName?: string } | null;
  return (
    <Text>
      SESSION {params.id ?? ""} PANEL {state?.panelName ?? ""}
    </Text>
  );
}

function BackProbe(): React.ReactElement {
  return <Text>BACK ROUTE</Text>;
}

function renderScreen(options: {
  readonly convene?: ConveneDataSource;
  readonly topic?: string;
  readonly panel?: string;
}): ReturnType<typeof render> {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    ...(options.convene !== undefined ? { convene: options.convene } : {}),
  } as TuiDataSources;
  const panel = options.panel ?? "acme";
  const topic = options.topic ?? "Roadmap";

  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter
          initialEntries={["/previous", { pathname: `/convene/${panel}/run`, state: { topic } }]}
          initialIndex={1}
        >
          <Routes>
            <Route path="/previous" element={<BackProbe />} />
            <Route
              path="/convene/:panel/run"
              element={<DebateStreamScreen theme={theme} isActive />}
            />
            <Route path="/sessions/:id" element={<SessionProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("DebateStreamScreen", () => {
  it("streams the transcript and cost, then navigates to the session detail with the debateId", async () => {
    let resolveEnd: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice", "Bob"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Hello world" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      onEvent({ kind: "cost", premiumRequests: 3, estimatedTotal: 5 });
      onEvent({ kind: "end", reason: "completed" });
      await ended;
      return { debateId: "deb-123", reason: "completed" };
    });

    const { lastFrame } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

    await flush();

    expect(streamDebate).toHaveBeenCalledWith(
      "acme",
      "Roadmap",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
    const streaming = lastFrame() ?? "";
    expect(streaming).toContain("Experts: Alice, Bob");
    expect(streaming).toContain("Round 1");
    expect(streaming).toContain("Alice");
    expect(streaming).toContain("Hello world");
    expect(streaming).toContain("Cost:");
    expect(streaming).toContain("3 premium");
    expect(streaming).toContain("5");

    resolveEnd();
    await flush();

    expect(lastFrame()).toContain("SESSION deb-123 PANEL acme");
  });

  it("cancels the in-flight debate on Escape and returns to the previous route", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Partial thought" });
      await new Promise<void>((resolve) => {
        const signal = options.signal;
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      return { debateId: undefined, reason: "aborted" };
    });

    const { stdin, lastFrame } = renderScreen({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    expect(lastFrame()).toContain("Partial thought");

    stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 140));
    await flush();

    expect(lastFrame()).toContain("BACK ROUTE");
  });

  it("aborts the debate on unmount and ignores events delivered after unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    let fireLate: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      fireLate = resolve;
    });
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, options, onEvent) => {
      capturedSignal = options.signal;
      onEvent({ kind: "panel", experts: ["Alice"] });
      await late;
      onEvent({ kind: "turn-delta", expert: "Alice", text: "late text" });
      return { debateId: "deb-late", reason: "aborted" };
    });

    const { unmount } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

    await flush();
    unmount();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fireLate();
    await flush();

    // Cleanup must abort the in-flight run so the debate stops streaming once
    // the screen is gone (no leaked work, no state updates after unmount).
    expect(capturedSignal?.aborted).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("renders a sanitized error line when an error event arrives", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "error", message: "boom\u0007\noops" });
      await new Promise<void>(() => undefined);
    });

    const { lastFrame } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

    await flush();

    // ink masks ESC[ sequences itself, but preserves BEL (\u0007) and newlines —
    // exactly the chars the screen's own sink sanitization must collapse/strip.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("boom oops");
    expect(frame).not.toContain("\u0007");
  });

  it("sanitizes streaming turn bodies and expert labels at the text sink", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "turn-start", expert: "Quill\u0007Bot", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Quill\u0007Bot", text: "safe\u0007payload" });
      await new Promise<void>(() => undefined);
    });

    const { lastFrame } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

    await flush();

    const frame = lastFrame() ?? "";
    // Body sink: the BEL between "safe" and "payload" is stripped.
    expect(frame).toContain("safepayload");
    // Label sink (toSingleLineDisplay): the turn header collapses to "QuillBot:".
    // Only the header emits the trailing colon, so the responder line cannot mask it.
    expect(frame).toContain("QuillBot:");
    expect(frame).not.toContain("\u0007");
  });

  it("collapses CR and line-separator controls in streamed turn bodies to one transcript row", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "safe\rSPOOF\u2028row\nmore" });
      await new Promise<void>(() => undefined);
    });

    const { lastFrame } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

    await flush();

    const frame = lastFrame() ?? "";
    // stripControlChars PRESERVES CR (\r), LF (\n) and U+2028, so a streamed body
    // could CR-overwrite a row or forge a fake transcript line. toSingleLineDisplay
    // collapses every separator run to a single space → one tamper-proof row.
    expect(frame).toContain("safe SPOOF row more");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("safe\rSPOOF");
  });

  it("never invokes the view state setter after unmount when a late event reaches the guard", async () => {
    let didUnmount = false;
    const setAfterUnmount = vi.fn();
    const realUseState = React.useState;
    // Wrap React's setter so we can observe whether applyIfMounted reaches setView
    // AFTER unmount. React 19 + ink silently no-op a post-unmount setState (no
    // console.error), so a naive "deliver a late event" assertion cannot bite —
    // observing the setter directly is the only thing that proves the guard works.
    const spiedUseState = (<S,>(
      init: S | (() => S),
    ): [S, React.Dispatch<React.SetStateAction<S>>] => {
      const [state, setState] = realUseState(init);
      // Wrap ONLY the `view` setter (the one applyIfMounted drives). Key on the
      // DebateView shape (has `turns`), never the `status` string state.
      if (init !== null && typeof init === "object" && !Array.isArray(init) && "turns" in init) {
        const wrapped: React.Dispatch<React.SetStateAction<S>> = (next) => {
          if (didUnmount) setAfterUnmount();
          setState(next);
        };
        return [state, wrapped];
      }
      return [state, setState];
    }) as typeof React.useState;
    const useStateSpy = vi.spyOn(React, "useState").mockImplementation(spiedUseState);

    let capturedOnEvent: ((event: ConveneViewEvent) => void) | undefined;
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      capturedOnEvent = onEvent;
      onEvent({ kind: "panel", experts: ["Alice"] });
      await new Promise<void>(() => undefined);
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { unmount } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

      await flush();
      expect(capturedOnEvent).toBeTypeOf("function");

      didUnmount = true;
      unmount();

      // Deliver a late event straight into applyIfMounted (== captured onEvent).
      // The unmountedRef guard must short-circuit BEFORE setView runs.
      capturedOnEvent?.({ kind: "turn-delta", expert: "Alice", text: "late" });
      await flush();

      expect(setAfterUnmount).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      useStateSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure-helper tests: transcriptLines(view, palette, theme)
// ---------------------------------------------------------------------------

describe("transcriptLines — pure formatter", () => {
  const noColorPalette = resolveExpertPalette({ NO_COLOR: "1" });
  const noColorTheme = resolveTheme({ NO_COLOR: "1" });
  const colorPalette = resolveExpertPalette({});

  const baseView = {
    experts: [] as readonly string[],
    turns: [
      { expert: "Alice", round: 1, body: "hello world", done: true },
    ] as readonly { readonly expert: string; readonly round: number; readonly body: string; readonly done: boolean }[],
    cost: undefined as { readonly premiumRequests: number; readonly estimatedTotal: number } | undefined,
    error: undefined as string | undefined,
  };

  it("with NO_COLOR produces plain text — round separator, speaker label, indented body", () => {
    const lines = transcriptLines(baseView, noColorPalette, noColorTheme);
    expect(lines).toContain("── Round 1 ──");
    expect(lines).toContain("Alice:");
    expect(lines).toContain("  hello world");
    // No ANSI escape codes anywhere
    expect(lines.join("")).not.toContain("\u001b[");
  });

  it("same expert maps to the same color index on every call (determinism)", () => {
    const idx1 = colorPalette.indexOf("Alice");
    const idx2 = colorPalette.indexOf("Alice");
    expect(idx1).toBe(idx2);
    expect(idx1).toBe(expertColorIndex("Alice"));
  });

  it("two experts with different palette indices produce distinct label colorization", () => {
    // Alice = charsum 510 → idx 0 (magenta); Bob = charsum 275 → idx 5 (red)
    expect(colorPalette.indexOf("Alice")).not.toBe(colorPalette.indexOf("Bob"));
    // boldColor must produce different ANSI-wrapped output for different indices
    const aliceColored = colorPalette.boldColor("Alice")("Alice:");
    const bobColored = colorPalette.boldColor("Bob")("Bob:");
    expect(aliceColored).not.toBe(bobColored);
  });

  it("sanitizes malicious body (CR / ESC sequences / line separators) before output", () => {
    const view = {
      ...baseView,
      turns: [
        {
          expert: "Alice",
          round: 1,
          body: "safe\rSPOOF\u001b[31mred\u001b[0m\u2028newline",
          done: true,
        },
      ] as readonly { readonly expert: string; readonly round: number; readonly body: string; readonly done: boolean }[],
    };
    const lines = transcriptLines(view, noColorPalette, noColorTheme);
    const bodyLine = lines.find((l) => l.startsWith("  "));
    expect(bodyLine).toBeDefined();
    // No raw control / injection chars in output
    expect(bodyLine).not.toContain("\r");
    expect(bodyLine).not.toContain("\u001b");
    expect(bodyLine).not.toContain("\u2028");
    // Content is preserved, collapsed to one line
    expect(bodyLine).toContain("safe");
    expect(bodyLine).toContain("SPOOF");
    expect(bodyLine).toContain("red");
  });

  it("round separator and speaker label are both present for a two-expert, two-round view", () => {
    const view = {
      experts: [] as readonly string[],
      turns: [
        { expert: "Alice", round: 1, body: "r1", done: true },
        { expert: "Bob", round: 1, body: "r1b", done: true },
        { expert: "Alice", round: 2, body: "r2", done: true },
      ] as readonly { readonly expert: string; readonly round: number; readonly body: string; readonly done: boolean }[],
      cost: undefined as { readonly premiumRequests: number; readonly estimatedTotal: number } | undefined,
      error: undefined as string | undefined,
    };
    const lines = transcriptLines(view, noColorPalette, noColorTheme);
    expect(lines.filter((l) => l.includes("Round 1")).length).toBe(1);
    expect(lines.filter((l) => l.includes("Round 2")).length).toBe(1);
    expect(lines.filter((l) => l.includes("Alice:")).length).toBe(2);
    expect(lines.filter((l) => l.includes("Bob:")).length).toBe(1);
  });
});

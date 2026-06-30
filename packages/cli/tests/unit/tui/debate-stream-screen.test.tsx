import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ConveneDataSource, ConveneViewEvent } from "../../../src/tui/adapters/convene.js";
import { toSingleLineDisplay } from "../../../src/cli/strip-control-chars.js";
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

function ConcludeProbe(): React.ReactElement {
  const params = useParams();
  const location = useLocation();
  const state = location.state as { readonly panelName?: string } | null;
  return (
    <Text>
      CONCLUDE {params.id ?? ""} PANEL {state?.panelName ?? ""}
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
            <Route path="/sessions/:id/conclude" element={<ConcludeProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("DebateStreamScreen", () => {
  it("streams the transcript and cost, then auto-concludes into the conclusion route on success", async () => {
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

    // On a successful debate the screen mirrors the classic CLI default and
    // navigates straight into the existing conclusion flow (decision matrix).
    expect(lastFrame()).toContain("CONCLUDE deb-123 PANEL acme");
    expect(lastFrame()).not.toContain("SESSION deb-123");
  });

  it("does not auto-conclude when the debate ends in a non-success reason", async () => {
    let resolveEnd: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Partial thought" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      onEvent({ kind: "end", reason: "aborted" });
      await ended;
      return { debateId: "deb-789", reason: "aborted" };
    });

    const { lastFrame } = renderScreen({ convene: { estimateCost: estimateStub, streamDebate } });

    await flush();
    resolveEnd();
    await flush();

    // An aborted/failed debate keeps the partial transcript and lands on the
    // session detail — it must NOT trigger conclusion synthesis.
    expect(lastFrame()).toContain("SESSION deb-789 PANEL acme");
    expect(lastFrame()).not.toContain("CONCLUDE deb-789");
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
// Review mode tests
// ---------------------------------------------------------------------------

describe("DebateStreamScreen — review mode", () => {
  function renderWithReview(options: {
    readonly convene: ConveneDataSource;
    readonly maxRows?: number;
  }): ReturnType<typeof render> {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      convene: options.convene,
    } as TuiDataSources;
    return render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter
            initialEntries={[{ pathname: "/convene/panel1/run", state: { topic: "Q" } }]}
          >
            <Routes>
              <Route
                path="/convene/:panel/run"
                element={
                  <DebateStreamScreen theme={theme} isActive maxRows={options.maxRows ?? 12} />
                }
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );
  }

  it("pressing ↑ shows the review mode banner and stops auto-following", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Hello world" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    // Baseline: live mode — no review banner
    expect(lastFrame()).not.toContain("Review");

    stdin.write("\x1B[A"); // Up arrow
    await flush();

    expect(lastFrame()).toContain("Review");
  });

  it("pressing End after entering review resumes live (banner disappears)", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Content" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    stdin.write("\x1B[A"); // Up arrow → enter review
    await flush();
    expect(lastFrame()).toContain("Review");

    stdin.write("\x1B[F"); // End key → resume live
    await flush();
    expect(lastFrame()).not.toContain("Review");
  });

  it("new transcript events while in review mode do not scroll the view back to the bottom", async () => {
    let capturedOnEvent: ((event: ConveneViewEvent) => void) | undefined;
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      capturedOnEvent = onEvent;
      onEvent({ kind: "panel", experts: ["Alice", "Bob"] });
      onEvent({ kind: "round", round: 1 });
      // Enough turns to overflow a 3-row viewport
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "AliceFirstTurn" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      onEvent({ kind: "turn-start", expert: "Bob", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Bob", text: "BobFirstTurn" });
      onEvent({ kind: "turn-end", expert: "Bob" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
      maxRows: 3,
    });

    await flush();

    stdin.write("\x1B[A"); // enter review
    await flush();
    expect(lastFrame()).toContain("Review");

    // Fire additional events while in review mode
    capturedOnEvent?.({ kind: "turn-start", expert: "Alice", round: 2 });
    capturedOnEvent?.({ kind: "turn-delta", expert: "Alice", text: "LateContent9999" });
    await flush();

    // Banner still present (still in review mode)
    expect(lastFrame()).toContain("Review");
    // The newly-appended content is NOT visible (viewport did not jump to bottom)
    expect(lastFrame()).not.toContain("LateContent9999");
  });

  it("pressing k enters review mode and suppresses new-content auto-scroll (like ↑)", async () => {
    let capturedOnEvent: ((event: ConveneViewEvent) => void) | undefined;
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      capturedOnEvent = onEvent;
      onEvent({ kind: "panel", experts: ["Alice", "Bob"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "AliceFirst" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      onEvent({ kind: "turn-start", expert: "Bob", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Bob", text: "BobFirst" });
      onEvent({ kind: "turn-end", expert: "Bob" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
      maxRows: 3,
    });

    await flush();
    expect(lastFrame()).not.toContain("Review");

    stdin.write("k");
    await flush();
    expect(lastFrame()).toContain("Review");

    capturedOnEvent?.({ kind: "turn-start", expert: "Alice", round: 2 });
    capturedOnEvent?.({ kind: "turn-delta", expert: "Alice", text: "LateContentK" });
    await flush();
    expect(lastFrame()).toContain("Review");
    expect(lastFrame()).not.toContain("LateContentK");
  });

  it("pressing PgUp enters review mode and suppresses new-content auto-scroll (like ↑)", async () => {
    let capturedOnEvent: ((event: ConveneViewEvent) => void) | undefined;
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      capturedOnEvent = onEvent;
      onEvent({ kind: "panel", experts: ["Alice", "Bob"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "AliceFirst" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      onEvent({ kind: "turn-start", expert: "Bob", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Bob", text: "BobFirst" });
      onEvent({ kind: "turn-end", expert: "Bob" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
      maxRows: 3,
    });

    await flush();
    expect(lastFrame()).not.toContain("Review");

    stdin.write("\x1B[5~"); // PgUp
    await flush();
    expect(lastFrame()).toContain("Review");

    capturedOnEvent?.({ kind: "turn-start", expert: "Alice", round: 2 });
    capturedOnEvent?.({ kind: "turn-delta", expert: "Alice", text: "LateContentPgUp" });
    await flush();
    expect(lastFrame()).toContain("Review");
    expect(lastFrame()).not.toContain("LateContentPgUp");
  });

  it("pressing ↓ from review mode resumes live (banner clears) when scrolled to end", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Content" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    stdin.write("\x1B[A"); // Up → enter review
    await flush();
    expect(lastFrame()).toContain("Review");

    stdin.write("\x1B[B"); // Down → cursor reaches end → resume live
    await flush();
    expect(lastFrame()).not.toContain("Review");
  });

  it("pressing j from review mode resumes live (banner clears) when scrolled to end", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Content" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    stdin.write("\x1B[A"); // Up → enter review
    await flush();
    expect(lastFrame()).toContain("Review");

    stdin.write("j"); // j → cursor reaches end → resume live
    await flush();
    expect(lastFrame()).not.toContain("Review");
  });

  it("pressing PgDn from review mode resumes live (banner clears) when scrolled to end", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Content" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    stdin.write("\x1B[A"); // Up → enter review
    await flush();
    expect(lastFrame()).toContain("Review");

    stdin.write("\x1B[6~"); // PgDn → cursor reaches end → resume live
    await flush();
    expect(lastFrame()).not.toContain("Review");
  });

  it("pressing G resumes live mode like End (banner clears)", async () => {
    const streamDebate = vi.fn<
      Parameters<ConveneDataSource["streamDebate"]>,
      ReturnType<ConveneDataSource["streamDebate"]>
    >(async (_panel, _topic, _options, onEvent) => {
      onEvent({ kind: "panel", experts: ["Alice"] });
      onEvent({ kind: "round", round: 1 });
      onEvent({ kind: "turn-start", expert: "Alice", round: 1 });
      onEvent({ kind: "turn-delta", expert: "Alice", text: "Content" });
      onEvent({ kind: "turn-end", expert: "Alice" });
      await new Promise<void>(() => undefined);
    });

    const { stdin, lastFrame } = renderWithReview({
      convene: { estimateCost: estimateStub, streamDebate },
    });

    await flush();
    stdin.write("\x1B[A"); // Up → enter review
    await flush();
    expect(lastFrame()).toContain("Review");

    stdin.write("G"); // G → resume live
    await flush();
    expect(lastFrame()).not.toContain("Review");
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
    turns: [{ expert: "Alice", round: 1, body: "hello world", done: true }] as readonly {
      readonly expert: string;
      readonly round: number;
      readonly body: string;
      readonly done: boolean;
    }[],
    cost: undefined as
      | { readonly premiumRequests: number; readonly estimatedTotal: number }
      | undefined,
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

  it("transcriptLines applies per-expert bold coloring — positive and negative controls", () => {
    // Build a two-expert view so the formatter exercises both label slots.
    const twoExpertView = {
      experts: [] as readonly string[],
      turns: [
        { expert: "Alice", round: 1, body: "hello", done: true },
        { expert: "Bob", round: 1, body: "world", done: true },
      ] as readonly {
        readonly expert: string;
        readonly round: number;
        readonly body: string;
        readonly done: boolean;
      }[],
      cost: undefined as
        | { readonly premiumRequests: number; readonly estimatedTotal: number }
        | undefined,
      error: undefined as string | undefined,
    };

    const colorTheme = resolveTheme({});
    const lines = transcriptLines(twoExpertView, colorPalette, colorTheme);

    const aliceExpected = colorPalette.boldColor("Alice")(toSingleLineDisplay("Alice:"));
    const bobExpected = colorPalette.boldColor("Bob")(toSingleLineDisplay("Bob:"));
    const alicePlain = toSingleLineDisplay("Alice:");

    // 1. The formatter emits the colorized label, not the plain string.
    expect(lines).toContain(aliceExpected);
    // Negative control: coloring must actually transform the string.
    expect(aliceExpected).not.toBe(alicePlain);
    // Negative control: the plain label must NOT appear as a standalone line element.
    expect(lines).not.toContain(alicePlain);

    // 2. Alice and Bob receive distinct per-expert colorization.
    expect(aliceExpected).not.toBe(bobExpected);
    expect(lines).toContain(bobExpected);

    // 3. Under NO_COLOR=1 the emitted label is the plain string — no ANSI leak.
    const noColorPal = resolveExpertPalette({ NO_COLOR: "1" });
    const noColorThm = resolveTheme({ NO_COLOR: "1" });
    const plainLines = transcriptLines(twoExpertView, noColorPal, noColorThm);
    expect(plainLines).toContain(alicePlain);
    expect(plainLines.join("")).not.toContain("\u001b[");
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
      ] as readonly {
        readonly expert: string;
        readonly round: number;
        readonly body: string;
        readonly done: boolean;
      }[],
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
      ] as readonly {
        readonly expert: string;
        readonly round: number;
        readonly body: string;
        readonly done: boolean;
      }[],
      cost: undefined as
        | { readonly premiumRequests: number; readonly estimatedTotal: number }
        | undefined,
      error: undefined as string | undefined,
    };
    const lines = transcriptLines(view, noColorPalette, noColorTheme);
    expect(lines.filter((l) => l.includes("Round 1")).length).toBe(1);
    expect(lines.filter((l) => l.includes("Round 2")).length).toBe(1);
    expect(lines.filter((l) => l.includes("Alice:")).length).toBe(2);
    expect(lines.filter((l) => l.includes("Bob:")).length).toBe(1);
  });
});

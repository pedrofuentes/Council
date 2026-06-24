import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ConveneDataSource } from "../../../src/tui/adapters/convene.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { DebateStreamScreen } from "../../../src/tui/screens/DebateStreamScreen.js";
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
    // Body sink (stripControlChars): the BEL between "safe" and "payload" is gone.
    expect(frame).toContain("safepayload");
    // Label sink (toSingleLineDisplay): the turn header collapses to "QuillBot:".
    // Only the header emits the trailing colon, so the responder line cannot mask it.
    expect(frame).toContain("QuillBot:");
    expect(frame).not.toContain("\u0007");
  });
});

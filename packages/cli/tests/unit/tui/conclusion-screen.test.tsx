import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type {
  ConcludeDataSource,
  ConcludeSynthesizeOptions,
  ConclusionView,
} from "../../../src/tui/adapters/conclude.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ConclusionScreen } from "../../../src/tui/screens/ConclusionScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function makeView(overrides: Partial<ConclusionView> = {}): ConclusionView {
  return {
    panelName: "Acme",
    topic: "Launch timing",
    consensus: ["Ship in Q3"],
    tensions: ["Budget vs speed"],
    decisionMatrix: [
      {
        dimension: "Risk vs Innovation",
        stances: [
          { expert: "conservative", stance: "Wait for data" },
          { expert: "progressive", stance: "Move fast" },
        ],
      },
    ],
    recommendation: "Adopt a phased rollout",
    confidence: "medium",
    warnings: [],
    ...overrides,
  };
}

function BackProbe(): React.ReactElement {
  return <Text>BACK ROUTE</Text>;
}

function buildTree(options: {
  readonly conclude?: ConcludeDataSource;
  readonly panelName?: string;
}): React.ReactElement {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    ...(options.conclude !== undefined ? { conclude: options.conclude } : {}),
  } as TuiDataSources;
  const panelName = options.panelName ?? "Acme";

  return (
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter
          initialEntries={[
            "/previous",
            { pathname: "/sessions/p1/conclude", state: { panelName } },
          ]}
          initialIndex={1}
        >
          <Routes>
            <Route path="/previous" element={<BackProbe />} />
            <Route
              path="/sessions/:id/conclude"
              element={<ConclusionScreen theme={theme} isActive />}
            />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>
  );
}

function renderScreen(options: {
  readonly conclude?: ConcludeDataSource;
  readonly panelName?: string;
}): ReturnType<typeof render> {
  return render(buildTree(options));
}

describe("ConclusionScreen", () => {
  it("renders the decision matrix, consensus, tensions, recommendation, and confidence", async () => {
    const synthesize = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(
      async () => makeView(),
    );

    const { lastFrame } = renderScreen({ conclude: { synthesize } });

    await flush();

    expect(synthesize).toHaveBeenCalledWith(
      "Acme",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Acme");
    expect(frame).toContain("Risk vs Innovation");
    expect(frame).toContain("conservative");
    expect(frame).toContain("Wait for data");
    expect(frame).toContain("progressive");
    expect(frame).toContain("Move fast");
    expect(frame).toContain("Ship in Q3");
    expect(frame).toContain("Budget vs speed");
    expect(frame).toContain("Adopt a phased rollout");
    expect(frame).toContain("medium");
  });

  it("aborts the in-flight synthesis on Escape and returns to the previous route", async () => {
    const synthesize = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(
      async (_panelName, options) =>
        new Promise<ConclusionView>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted === true) {
            reject(new Error("cancelled"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );

    const { stdin, lastFrame } = renderScreen({ conclude: { synthesize } });

    await flush();
    // Loading state is on screen while synthesis is pending.
    expect(lastFrame()).not.toContain("BACK ROUTE");

    stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 140));
    await flush();

    expect(lastFrame()).toContain("BACK ROUTE");
  });

  it("renders a sanitized error line when synthesis rejects with a non-abort error", async () => {
    const synthesize = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(
      async () => {
        throw new Error("boom\u0007\noops");
      },
    );

    const { lastFrame } = renderScreen({ conclude: { synthesize } });

    await flush();

    const frame = lastFrame() ?? "";
    // The screen's own sink must strip BEL and collapse the newline.
    expect(frame).toContain("boom oops");
    expect(frame).not.toContain("\u0007");
  });

  it("sanitizes every untrusted view string at the text sink", async () => {
    const synthesize = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(
      async () =>
        makeView({
          consensus: ["ship\u0007now"],
          tensions: ["risk\rSPOOF"],
          decisionMatrix: [
            {
              dimension: "Risk\u2028OVERWRITE",
              stances: [{ expert: "hawk\u0007", stance: "go\u2029fast" }],
            },
          ],
          recommendation: "do\u2029it",
        }),
    );

    const { lastFrame } = renderScreen({ conclude: { synthesize } });

    await flush();

    const frame = lastFrame() ?? "";
    // stripControlChars would PRESERVE \r \n \u2028 \u2029, leaving row-spoofing
    // payloads intact. toSingleLineDisplay collapses them to a single space.
    expect(frame).toContain("shipnow");
    expect(frame).toContain("risk SPOOF");
    expect(frame).toContain("Risk OVERWRITE");
    expect(frame).toContain("go fast");
    expect(frame).toContain("do it");
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("\u2029");
    expect(frame).not.toContain("risk\rSPOOF");
  });

  it("never invokes the state setter after unmount when synthesis resolves late", async () => {
    let didUnmount = false;
    const setAfterUnmount = vi.fn();
    const realUseState = React.useState;
    const spiedUseState = (<S,>(
      init: S | (() => S),
    ): [S, React.Dispatch<React.SetStateAction<S>>] => {
      const [state, setState] = realUseState(init);
      // Wrap ONLY the conclusion screen state setter (the object carrying `view`).
      if (init !== null && typeof init === "object" && !Array.isArray(init) && "view" in init) {
        const wrapped: React.Dispatch<React.SetStateAction<S>> = (next) => {
          if (didUnmount) setAfterUnmount();
          setState(next);
        };
        return [state, wrapped];
      }
      return [state, setState];
    }) as typeof React.useState;
    const useStateSpy = vi.spyOn(React, "useState").mockImplementation(spiedUseState);

    let resolveSynth: (view: ConclusionView) => void = () => undefined;
    const synthesize = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(
      async () =>
        new Promise<ConclusionView>((resolve) => {
          resolveSynth = resolve;
        }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { unmount } = renderScreen({ conclude: { synthesize } });

      await flush();
      expect(synthesize).toHaveBeenCalledTimes(1);

      didUnmount = true;
      unmount();

      // Synthesis settles AFTER unmount: the unmountedRef guard must block setState.
      resolveSynth(makeView());
      await flush();

      expect(setAfterUnmount).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      useStateSpy.mockRestore();
    }
  });

  it("re-runs synthesis when its data source changes (resets startedRef on cleanup)", async () => {
    const first = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(async () =>
      makeView(),
    );
    const second = vi.fn<[string, ConcludeSynthesizeOptions?], Promise<ConclusionView>>(async () =>
      makeView({ recommendation: "Second pass" }),
    );

    const { rerender, lastFrame } = renderScreen({ conclude: { synthesize: first } });
    await flush();
    expect(first).toHaveBeenCalledTimes(1);

    // Same mounted screen, new data source identity → effect must clean up and
    // re-run. If startedRef is not reset on cleanup (#1677), `second` never runs.
    rerender(buildTree({ conclude: { synthesize: second } }));
    await flush();

    expect(second).toHaveBeenCalledTimes(1);
    expect(lastFrame() ?? "").toContain("Second pass");
  });
});

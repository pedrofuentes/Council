import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ConveneDataSource } from "../../../src/tui/adapters/convene.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ConvenePromptScreen } from "../../../src/tui/screens/ConvenePromptScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function RunProbe(): React.ReactElement {
  const params = useParams();
  const location = useLocation();
  const state = location.state as { readonly topic?: string } | null;
  return (
    <Text>
      RUN {params.panel} TOPIC {state?.topic ?? ""}
    </Text>
  );
}

function BackProbe(): React.ReactElement {
  return <Text>BACK ROUTE</Text>;
}

function renderScreen(options: {
  readonly convene?: ConveneDataSource;
  readonly initialEntries?: readonly [string, { readonly pathname: string }];
  readonly initialIndex?: number;
}): ReturnType<typeof render> {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    ...(options.convene !== undefined ? { convene: options.convene } : {}),
  } as TuiDataSources;

  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter
          initialEntries={options.initialEntries ?? ["/previous", { pathname: "/convene/acme" }]}
          initialIndex={options.initialIndex ?? 1}
        >
          <Routes>
            <Route path="/previous" element={<BackProbe />} />
            <Route
              path="/convene/:panel"
              element={<ConvenePromptScreen theme={theme} isActive />}
            />
            <Route path="/convene/:panel/run" element={<RunProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("ConvenePromptScreen", () => {
  it("estimates cost after topic submit and shows the confirmation modal", async () => {
    const estimateCost = vi.fn<
      Parameters<ConveneDataSource["estimateCost"]>,
      Promise<{ experts: number; rounds: number; estimatedPremiumRequests: number }>
    >(async () => ({
      experts: 2,
      rounds: 3,
      estimatedPremiumRequests: 6,
    }));
    const { stdin, lastFrame } = renderScreen({
      convene: {
        estimateCost,
        streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
      },
    });

    await flush();
    stdin.write("Launch\nroadmap");
    await flush();
    stdin.write("\r");
    await flush();

    expect(estimateCost).toHaveBeenCalledWith("acme");
    expect(lastFrame()).toContain(
      "Run debate with 2 experts × 3 rounds (~6 premium requests)? [y/n]",
    );
    expect(lastFrame()).not.toContain("\nroadmap");
  });

  it("navigates to the run route with sanitized topic state on y", async () => {
    const { stdin, lastFrame } = renderScreen({
      convene: {
        estimateCost: async () => ({ experts: 1, rounds: 2, estimatedPremiumRequests: 2 }),
        streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
      },
    });

    await flush();
    stdin.write("Launch\u001B[31m roadmap");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("y");
    await flush();

    expect(lastFrame()).toContain("RUN acme TOPIC Launch roadmap");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("cancels to the back-stack route on n or idle Escape", async () => {
    const convene: ConveneDataSource = {
      estimateCost: async () => ({ experts: 1, rounds: 1, estimatedPremiumRequests: 1 }),
      streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
    };
    const first = renderScreen({ convene });
    await flush();
    first.stdin.write("Topic");
    await flush();
    first.stdin.write("\r");
    await flush();
    first.stdin.write("n");
    await flush();
    expect(first.lastFrame()).toContain("BACK ROUTE");
    first.unmount();

    const second = renderScreen({ convene });
    await flush();
    second.stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 140));
    await flush();
    expect(second.lastFrame()).toContain("BACK ROUTE");
  });

  it("does not submit an empty topic", async () => {
    const estimateCost = vi.fn<
      Parameters<ConveneDataSource["estimateCost"]>,
      Promise<{ experts: number; rounds: number; estimatedPremiumRequests: number }>
    >(async () => ({
      experts: 1,
      rounds: 1,
      estimatedPremiumRequests: 1,
    }));
    const { stdin, lastFrame } = renderScreen({
      convene: {
        estimateCost,
        streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
      },
    });

    await flush();
    stdin.write("   ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(estimateCost).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Topic:");
  });

  it("shows a sanitized inline error when estimateCost rejects", async () => {
    const { stdin, lastFrame } = renderScreen({
      convene: {
        estimateCost: async () => {
          throw new Error("Nope\n\u001B[31mtry again");
        },
        streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
      },
    });

    await flush();
    stdin.write("Topic");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("Nope try again");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("renders convene unavailable when no source is wired", async () => {
    const { lastFrame } = renderScreen({});

    await flush();

    expect(lastFrame()).toContain("convene unavailable");
  });

  it("guards confirm so it only fires once after the estimate loads", async () => {
    let resolveEstimate: (value: {
      experts: number;
      rounds: number;
      estimatedPremiumRequests: number;
    }) => void = () => undefined;
    const estimateCost = vi.fn<
      Parameters<ConveneDataSource["estimateCost"]>,
      Promise<{ experts: number; rounds: number; estimatedPremiumRequests: number }>
    >(
      async () =>
        new Promise((resolve) => {
          resolveEstimate = resolve;
        }),
    );
    const { stdin, lastFrame } = renderScreen({
      convene: {
        estimateCost,
        streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
      },
    });

    await flush();
    stdin.write("Topic");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("y");
    await flush();
    expect(lastFrame()).not.toContain("RUN acme");

    resolveEstimate({ experts: 1, rounds: 1, estimatedPremiumRequests: 1 });
    await flush();
    stdin.write("y");
    stdin.write("y");
    await flush();

    expect(lastFrame()).toContain("RUN acme TOPIC Topic");
  });
});

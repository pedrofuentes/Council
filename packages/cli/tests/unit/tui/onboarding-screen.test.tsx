import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { OnboardingDataSource, OnboardingView } from "../../../src/tui/adapters/onboarding.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { OnboardingScreen } from "../../../src/tui/screens/OnboardingScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

const viewFor = (overrides: Partial<OnboardingView> = {}): OnboardingView => ({
  isFirstRun: true,
  usedFallback: false,
  models: [
    { id: "claude-sonnet-4.5", label: "claude-sonnet-4.5", recommended: true },
    { id: "gpt-5.4", label: "gpt-5.4", recommended: false },
  ],
  ...overrides,
});

const createSource = (overrides: Partial<OnboardingDataSource> = {}): OnboardingDataSource => ({
  load: async () => viewFor(),
  complete: async () => undefined,
  ...overrides,
});

const sourcesWith = (source?: OnboardingDataSource): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    onboarding: source,
  }) as TuiDataSources;

function HomeProbe(): React.ReactElement {
  return <Text>HOME SCREEN</Text>;
}

function renderScreen(source?: OnboardingDataSource): ReturnType<typeof render> {
  return render(
    <InputCaptureProvider>
      <DataProvider value={sourcesWith(source)}>
        <MemoryRouter initialEntries={["/onboarding"]}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingScreen theme={theme} isActive />} />
            <Route path="/" element={<HomeProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("OnboardingScreen", () => {
  it("renders the welcome message and the discovered model options", async () => {
    const { lastFrame, unmount } = renderScreen(createSource());

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/welcome to council/i);
    expect(frame).toContain("claude-sonnet-4.5");
    expect(frame).toContain("gpt-5.4");
    expect(frame.toLowerCase()).toContain("recommended");
    unmount();
  });

  it("notes when the model list is a built-in fallback", async () => {
    const { lastFrame, unmount } = renderScreen(
      createSource({ load: async () => viewFor({ usedFallback: true }) }),
    );

    await flush();

    expect((lastFrame() ?? "").toLowerCase()).toContain("fallback");
    unmount();
  });

  it("sanitizes model labels rendered to the Text sink", async () => {
    const { lastFrame, unmount } = renderScreen(
      createSource({
        load: async () =>
          viewFor({ models: [{ id: "raw", label: "ev\u001B[31mil", recommended: true }] }),
      }),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("evil");
    expect(frame).not.toContain("\u001B[31m");
    unmount();
  });

  it("confirms the highlighted model and proceeds to the home screen", async () => {
    const complete = vi.fn(async () => undefined);
    const { stdin, lastFrame, unmount } = renderScreen(createSource({ complete }));

    await flush();
    stdin.write("\r");
    await flush();

    expect(complete).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(lastFrame()).toContain("HOME SCREEN");
    unmount();
  });

  it("moves the cursor with the arrow keys and confirms the second model", async () => {
    const complete = vi.fn(async () => undefined);
    const { stdin, unmount } = renderScreen(createSource({ complete }));

    await flush();
    stdin.write("\u001B[B");
    await flush();
    stdin.write("\r");
    await flush();

    expect(complete).toHaveBeenCalledWith("gpt-5.4");
    unmount();
  });

  it("skips onboarding on idle Esc without persisting a model", async () => {
    const complete = vi.fn(async () => undefined);
    const { stdin, lastFrame, unmount } = renderScreen(createSource({ complete }));

    await flush();
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).toContain("HOME SCREEN");
    expect(complete).not.toHaveBeenCalled();
    unmount();
  });

  it("ignores Esc while a model choice is being persisted", async () => {
    const { stdin, lastFrame, unmount } = renderScreen(
      createSource({ complete: async () => new Promise(() => undefined) }),
    );

    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).not.toContain("HOME SCREEN");
    unmount();
  });

  it("shows a sanitized error when persisting the model fails", async () => {
    const { stdin, lastFrame, unmount } = renderScreen(
      createSource({
        complete: async () => {
          throw new Error("disk\n\u001B[31mfull");
        },
      }),
    );

    await flush();
    stdin.write("\r");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("disk full");
    expect(frame).not.toContain("\u001B[31m");
    expect(frame).not.toContain("HOME SCREEN");
    unmount();
  });

  it("reports unavailable when the onboarding source is missing", async () => {
    const { lastFrame, unmount } = renderScreen(undefined);

    await flush();

    expect((lastFrame() ?? "").toLowerCase()).toContain("unavailable");
    unmount();
  });

  it("shows a no-models notice and ignores confirm when none are available", async () => {
    const complete = vi.fn(async () => undefined);
    const { stdin, lastFrame, unmount } = renderScreen(
      createSource({ load: async () => viewFor({ models: [] }), complete }),
    );

    await flush();
    expect((lastFrame() ?? "").toLowerCase()).toMatch(/no .*models/i);

    stdin.write("\r");
    await flush();
    expect(complete).not.toHaveBeenCalled();
    unmount();
  });
});

const homeData: HomeData = {
  counts: { sessions: 1, experts: 1, panels: 1 },
  recent: [{ id: "s1", title: "Build vs buy", when: "2d", status: "convened" }],
};

describe("CouncilTUI first-run onboarding routing", () => {
  it("starts on the onboarding screen when isFirstRun is true", async () => {
    const { lastFrame, unmount } = render(
      <DataProvider value={sourcesWith(createSource())}>
        <CouncilTUI
          homeData={homeData}
          model="m"
          env={{ NO_COLOR: "1" }}
          initialColumns={140}
          initialRows={40}
          isFirstRun
        />
      </DataProvider>,
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/welcome to council/i);
    expect(frame).not.toContain("Build vs buy");
    unmount();
  });

  it("starts on the home screen when isFirstRun is false", async () => {
    const { lastFrame, unmount } = render(
      <DataProvider value={sourcesWith(createSource())}>
        <CouncilTUI
          homeData={homeData}
          model="m"
          env={{ NO_COLOR: "1" }}
          initialColumns={140}
          initialRows={40}
        />
      </DataProvider>,
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build vs buy");
    expect(frame).not.toMatch(/welcome to council/i);
    unmount();
  });

  it("advances from onboarding to home after confirming a model", async () => {
    const complete = vi.fn(async () => undefined);
    const { stdin, lastFrame, unmount } = render(
      <DataProvider value={sourcesWith(createSource({ complete }))}>
        <CouncilTUI
          homeData={homeData}
          model="m"
          env={{ NO_COLOR: "1" }}
          initialColumns={140}
          initialRows={40}
          isFirstRun
        />
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(complete).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(lastFrame()).toContain("Build vs buy");
    unmount();
  });
});

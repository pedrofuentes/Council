import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ResolvedPanelDefinition } from "../../../src/core/template-loader.js";
import type { PanelComposeDataSource } from "../../../src/tui/adapters/panel-compose.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { PanelComposeScreen } from "../../../src/tui/screens/PanelComposeScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

const submitTopic = async (
  stdin: { write: (input: string) => void },
  topic: string,
): Promise<void> => {
  stdin.write(topic);
  await flush();
  stdin.write("\r");
  await flush();
};

const definition: ResolvedPanelDefinition = {
  name: "raw-panel",
  description: "raw description",
  experts: [
    {
      slug: "optimist",
      displayName: "Raw Optimist",
      role: "Optimistic role",
      expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "evidence first",
      kind: "generic",
    },
  ],
};

function DetailProbe(): React.ReactElement {
  const params = useParams();
  return <Text>DETAIL {params.name}</Text>;
}

function createSource(overrides: Partial<PanelComposeDataSource> = {}): PanelComposeDataSource {
  return {
    compose: async () => ({
      name: "Safe Panel",
      description: "Safe description",
      experts: [{ displayName: "Safe Optimist", role: "Clean role" }],
      definition,
    }),
    persist: async () => ({ panelName: "safe-panel" }),
    ...overrides,
  };
}

function renderScreen(source?: PanelComposeDataSource): ReturnType<typeof render> {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    panelCompose: source,
  } as TuiDataSources;
  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/panels/compose"]}>
          <Routes>
            <Route path="/panels/compose" element={<PanelComposeScreen theme={theme} isActive />} />
            <Route path="/panels/:name" element={<DetailProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("PanelComposeScreen", () => {
  it("captures a topic and submits it to compose", async () => {
    const compose = vi.fn<
      Parameters<PanelComposeDataSource["compose"]>,
      ReturnType<PanelComposeDataSource["compose"]>
    >(createSource().compose);
    const { stdin, lastFrame, unmount } = renderScreen(createSource({ compose }));

    stdin.write("pricing strategy");
    await flush();
    stdin.write("\r");
    await flush();

    expect(compose).toHaveBeenCalledWith("pricing strategy");
    expect(lastFrame()).toContain("Safe Panel");
    unmount();
  });

  it("renders sanitized preview experts returned by the data source", async () => {
    const { stdin, lastFrame, unmount } = renderScreen(
      createSource({
        compose: async () => ({
          name: "Panel Name",
          description: "Desc text",
          experts: [{ displayName: "Expert Clean", role: "Role Clean" }],
          definition,
        }),
      }),
    );

    await submitTopic(stdin, "topic");

    expect(lastFrame()).toContain("Panel Name");
    expect(lastFrame()).toContain("Expert Clean");
    expect(lastFrame()).toContain("Role Clean");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("persists the preview on y and navigates to the saved panel", async () => {
    const persist = vi.fn<
      Parameters<PanelComposeDataSource["persist"]>,
      ReturnType<PanelComposeDataSource["persist"]>
    >(async () => ({ panelName: "safe-panel" }));
    const { stdin, lastFrame, unmount } = renderScreen(createSource({ persist }));

    await submitTopic(stdin, "topic");
    stdin.write("y");
    await flush();

    expect(persist).toHaveBeenCalledWith(definition);
    expect(lastFrame()).toContain("DETAIL safe-panel");
    unmount();
  });

  it("does not double-fire submit while compose is pending", async () => {
    const compose = vi.fn<
      Parameters<PanelComposeDataSource["compose"]>,
      ReturnType<PanelComposeDataSource["compose"]>
    >(async () => new Promise(() => undefined));
    const { stdin, unmount } = renderScreen(createSource({ compose }));

    stdin.write("topic");
    await flush();
    stdin.write("\r");
    stdin.write("\r");
    await flush();

    expect(compose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not double-fire confirm while persist is pending", async () => {
    const persist = vi.fn<
      Parameters<PanelComposeDataSource["persist"]>,
      ReturnType<PanelComposeDataSource["persist"]>
    >(async () => new Promise(() => undefined));
    const { stdin, unmount } = renderScreen(createSource({ persist }));

    await submitTopic(stdin, "topic");
    stdin.write("y");
    stdin.write("y");
    await flush();

    expect(persist).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("shows a sanitized error when compose rejects", async () => {
    const { stdin, lastFrame, unmount } = renderScreen(
      createSource({
        compose: async () => {
          throw new Error("bad\n\u001B[31mcompose");
        },
      }),
    );

    await submitTopic(stdin, "topic");

    expect(lastFrame()).toContain("bad compose");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("reports unavailable when the data source is missing", async () => {
    const { lastFrame, unmount } = renderScreen(undefined);

    await flush();

    expect(lastFrame()).toContain("Panel auto-compose unavailable");
    unmount();
  });

  it("navigates back on idle Esc", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      panelCompose: createSource(),
    } as TuiDataSources;
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels", "/panels/compose"]}>
            <Routes>
              <Route path="/panels" element={<Text>PANELS LIST</Text>} />
              <Route
                path="/panels/compose"
                element={<PanelComposeScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).toContain("PANELS LIST");
    unmount();
  });

  it("ignores Esc while compose is in flight", async () => {
    const { stdin, lastFrame, unmount } = renderScreen(
      createSource({ compose: async () => new Promise(() => undefined) }),
    );

    await submitTopic(stdin, "topic");
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).toContain("Composing");
    unmount();
  });

  it("ignores Esc while persist is in flight", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      panelCompose: createSource({ persist: async () => new Promise(() => undefined) }),
    } as TuiDataSources;
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels", "/panels/compose"]}>
            <Routes>
              <Route path="/panels" element={<Text>PANELS LIST</Text>} />
              <Route
                path="/panels/compose"
                element={<PanelComposeScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await submitTopic(stdin, "topic");
    stdin.write("y");
    await flush();
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).not.toContain("PANELS LIST");
    expect(lastFrame()).toContain("Saving");
    unmount();
  });
});

import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it } from "vitest";

import type { PanelListItem } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { PanelsScreen } from "../../../src/tui/screens/PanelsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};
const withPanels = (loadList: () => Promise<readonly PanelListItem[]>): TuiDataSources => ({
  panels: { loadList, loadDetail: async () => undefined },
});

function DetailProbe(): React.ReactElement {
  const params = useParams();
  return <Text>DETAIL {params.name}</Text>;
}

describe("PanelsScreen", () => {
  it("renders loaded panels", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme\u001B[31m", description: "Exec\nPanel", memberCount: 2, source: "saved" },
          { name: "startup-board", description: "tpl", memberCount: 3, source: "template" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toContain("acme");
    expect(lastFrame()).toContain("Exec Panel");
    expect(lastFrame()).toContain("startup-board");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("shows an empty state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}>
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/No panels/i);
    expect(lastFrame()).toContain("create one with n");
  });

  it("shows an error state", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => {
          throw new Error("x");
        })}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/Failed to load panels/i);
  });

  it("navigates to the selected panel detail on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme", description: "Exec panel", memberCount: 1, source: "saved" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/:name" element={<DetailProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("DETAIL acme");
  });

  it("navigates to panel creation with n in the non-empty state", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme", description: "Exec panel", memberCount: 1, source: "saved" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("n");
    await flush();

    expect(lastFrame()).toContain("NEW PANEL");
  });

  it("navigates to panel creation with n in the empty state", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}>
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("n");
    await flush();

    expect(lastFrame()).toContain("NEW PANEL");
  });
});

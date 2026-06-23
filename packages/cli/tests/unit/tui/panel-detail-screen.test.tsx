import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import type { PanelDetailView } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { PanelDetailScreen } from "../../../src/tui/screens/PanelDetailScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withDetail = (
  loadDetail: (name: string, source: "saved" | "template") => Promise<PanelDetailView | undefined>,
): TuiDataSources => ({
  panels: {
    loadList: async () => [],
    loadDetail,
  },
});

describe("PanelDetailScreen", () => {
  it("renders members, defaults, and missing slugs", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme\u001B[31m",
          description: "Exec\nPanel",
          source: "saved",
          defaults: { mode: "structured", maxRounds: 3, model: "gpt\u001B[32m" },
          members: [
            {
              slug: "cto",
              displayName: "Chief\u001B[31m Tech",
              role: "Technology\nStrategy",
              kind: "generic",
            },
          ],
          missing: ["ghost\u001B[33m"],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Chief Tech");
    expect(lastFrame()).toContain("Technology Strategy");
    expect(lastFrame()).toContain("ghost");
    expect(lastFrame()).toContain("structured");
    expect(lastFrame()).toContain("3 rounds");
    expect(lastFrame()).toContain("gpt");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("renders a not found state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withDetail(async () => undefined)}>
        <MemoryRouter
          initialEntries={[{ pathname: "/panels/missing", state: { source: "saved" } }]}
        >
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/not found/i);
  });

  it("returns to the list on Escape", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter
          initialEntries={["/panels", { pathname: "/panels/acme", state: { source: "saved" } }]}
          initialIndex={1}
        >
          <Routes>
            <Route path="/panels" element={<Text>LIST</Text>} />
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 120));
    await flush();

    expect(lastFrame()).toContain("LIST");
  });
});

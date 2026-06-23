import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it } from "vitest";

import type { ExpertListItem } from "../../../src/tui/adapters/experts-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { ExpertsScreen } from "../../../src/tui/screens/ExpertsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withExperts = (loadList: () => Promise<readonly ExpertListItem[]>): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  experts: { loadList, loadDetail: async () => undefined },
});

function SlugProbe(): React.ReactElement {
  const params = useParams();
  return <Text>EXPERT {params.slug}</Text>;
}

describe("ExpertsScreen", () => {
  it("renders loaded experts with panel counts", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withExperts(async () => [
          {
            slug: "cto\u001B[31m",
            displayName: "Chief\nTech",
            role: "Technology\u001B[32m Strategy",
            kind: "generic",
            panelCount: 2,
          },
          {
            slug: "cfo",
            displayName: "Chief Financial Officer",
            role: "Finance",
            kind: "persona",
            panelCount: 1,
          },
        ])}
      >
        <MemoryRouter initialEntries={["/experts"]}>
          <ExpertsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Chief Tech");
    expect(lastFrame()).toContain("2 panels");
    expect(lastFrame()).toContain("Chief Financial Officer");
    expect(lastFrame()).toContain("1 panels");
    expect(lastFrame()).not.toContain("\u001B[31m");
    expect(lastFrame()).not.toContain("\u001B[32m");
  });

  it("shows an empty state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExperts(async () => [])}>
        <MemoryRouter initialEntries={["/experts"]}>
          <ExpertsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No experts/i);
  });

  it("shows an error state", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withExperts(async () => {
          throw new Error("boom");
        })}
      >
        <MemoryRouter initialEntries={["/experts"]}>
          <ExpertsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/Failed to load experts/i);
  });

  it("navigates to the selected expert detail on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withExperts(async () => [
          {
            slug: "cto/lead",
            displayName: "Chief Tech",
            role: "Technology",
            kind: "generic",
            panelCount: 2,
          },
        ])}
      >
        <MemoryRouter initialEntries={["/experts"]}>
          <Routes>
            <Route path="/experts" element={<ExpertsScreen theme={theme} isActive />} />
            <Route path="/experts/:slug" element={<SlugProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("EXPERT cto/lead");
  });

  it("uses an empty list when the experts source is absent", async () => {
    const value: TuiDataSources = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
    };

    const { lastFrame } = render(
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/experts"]}>
          <ExpertsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No experts/i);
  });
});

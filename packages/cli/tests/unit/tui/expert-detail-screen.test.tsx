import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import type { ExpertDetailView } from "../../../src/tui/adapters/experts-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { ExpertDetailScreen } from "../../../src/tui/screens/ExpertDetailScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withDetail = (
  loadDetail: (slug: string) => Promise<ExpertDetailView | undefined>,
): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  experts: { loadList: async () => [], loadDetail },
});

describe("ExpertDetailScreen", () => {
  it("renders persona detail with sanitized expertise, personality, and panels", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          slug: "cto\u001B[35m",
          displayName: "CTO\u001B[31m",
          role: "Technology\nStrategy",
          kind: "persona",
          model: "gpt\u001B[32m-4o",
          epistemicStance: "Evidence\u001B[33m first",
          expertise: {
            weightedEvidence: ["Architecture\u001B[34m reviews"],
            referenceCases: ["Scaling\nplatform teams"],
            notExpertIn: ["Tax\u001B[36m law"],
          },
          personality: "Direct\u001B[31m and pragmatic",
          personaDescription: "Seasoned\noperator",
          panels: ["Exec\u001B[32m Panel"],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/experts/cto" }]}>
          <Routes>
            <Route path="/experts/:slug" element={<ExpertDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("CTO");
    expect(lastFrame()).toContain("Technology Strategy");
    expect(lastFrame()).toContain("Evidence first");
    expect(lastFrame()).toContain("Architecture reviews");
    expect(lastFrame()).toContain("Direct and pragmatic");
    expect(lastFrame()).toContain("Exec Panel");
    expect(lastFrame()).not.toContain("\u001B[31m");
    expect(lastFrame()).not.toContain("\u001B[32m");
    expect(lastFrame()).not.toContain("\u001B[33m");
    expect(lastFrame()).not.toContain("\u001B[34m");
  });

  it("renders a not found state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withDetail(async () => undefined)}>
        <MemoryRouter initialEntries={[{ pathname: "/experts/missing" }]}>
          <Routes>
            <Route path="/experts/:slug" element={<ExpertDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/not found/i);
  });

  it("renders a generic expert with empty expertise and no panels", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          slug: "ops",
          displayName: "Operations Lead",
          role: "Operations",
          kind: "generic",
          epistemicStance: "Finds bottlenecks",
          expertise: {
            weightedEvidence: [],
            referenceCases: [],
            notExpertIn: [],
          },
          panels: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/experts/ops" }]}>
          <Routes>
            <Route path="/experts/:slug" element={<ExpertDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Operations Lead");
    expect(lastFrame()).toContain("Operations [generic]");
    expect(lastFrame()).toContain("(none)");
  });

  it("navigates to the edit route when e is pressed while active", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          slug: "cto",
          displayName: "CTO",
          role: "Technology",
          kind: "generic",
          epistemicStance: "Evidence first",
          expertise: {
            weightedEvidence: [],
            referenceCases: [],
            notExpertIn: [],
          },
          panels: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/experts/cto" }]}>
          <Routes>
            <Route path="/experts/:slug" element={<ExpertDetailScreen theme={theme} isActive />} />
            <Route path="/experts/:slug/edit" element={<Text>EDIT ROUTE</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("e");
    await flush();

    expect(lastFrame()).toContain("EDIT ROUTE");
  });

  it("navigates to the delete route when d is pressed while active", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          slug: "cto",
          displayName: "CTO",
          role: "Technology",
          kind: "generic",
          epistemicStance: "Evidence first",
          expertise: {
            weightedEvidence: [],
            referenceCases: [],
            notExpertIn: [],
          },
          panels: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/experts/cto" }]}>
          <Routes>
            <Route path="/experts/:slug" element={<ExpertDetailScreen theme={theme} isActive />} />
            <Route path="/experts/:slug/delete" element={<Text>DELETE ROUTE</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("d");
    await flush();

    expect(lastFrame()).toContain("DELETE ROUTE");
  });
});

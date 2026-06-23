import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it } from "vitest";

import type { SessionListItem } from "../../../src/tui/adapters/sessions-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { SessionsScreen } from "../../../src/tui/screens/SessionsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withSessions = (loadList: () => Promise<readonly SessionListItem[]>): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  sessions: { loadList },
});

function IdProbe(): React.ReactElement {
  const params = useParams();
  return <Text>SESSION {params.id}</Text>;
}

describe("SessionsScreen", () => {
  it("renders loaded sessions with status symbols and counts", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withSessions(async () => [
          {
            panelId: "panel-running",
            panelName: "Growth\u001B[31m\nCouncil",
            topic: "Expansion\u001B[32m",
            debateCount: 2,
            turnCount: 9,
            latestStatus: "running",
            updatedAt: "2026-06-22T12:00:00.000Z",
          },
          {
            panelId: "panel-completed",
            panelName: "Finance Council",
            topic: "",
            debateCount: 1,
            turnCount: 4,
            latestStatus: "completed",
            updatedAt: "2026-06-22T11:00:00.000Z",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/sessions"]}>
          <SessionsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("… Growth Council");
    expect(lastFrame()).toContain("2 debates · 9 turns");
    expect(lastFrame()).toContain("Expansion");
    expect(lastFrame()).toContain("✓ Finance Council");
    expect(lastFrame()).toContain("1 debates · 4 turns");
    expect(lastFrame()).not.toContain("\u001B[31m");
    expect(lastFrame()).not.toContain("\u001B[32m");
  });

  it("shows an empty state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withSessions(async () => [])}>
        <MemoryRouter initialEntries={["/sessions"]}>
          <SessionsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No sessions/i);
  });

  it("shows an error state", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withSessions(async () => {
          throw new Error("boom");
        })}
      >
        <MemoryRouter initialEntries={["/sessions"]}>
          <SessionsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/Failed to load sessions/i);
  });

  it("navigates to the selected session detail on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withSessions(async () => [
          {
            panelId: "panel/42",
            panelName: "Growth Council",
            topic: "Expansion",
            debateCount: 2,
            turnCount: 9,
            latestStatus: "running",
            updatedAt: "2026-06-22T12:00:00.000Z",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/sessions"]}>
          <Routes>
            <Route path="/sessions" element={<SessionsScreen theme={theme} isActive />} />
            <Route path="/sessions/:id" element={<IdProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("SESSION panel/42");
  });

  it("uses an empty list when the sessions source is absent", async () => {
    const value: TuiDataSources = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
    };

    const { lastFrame } = render(
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/sessions"]}>
          <SessionsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No sessions/i);
  });
});

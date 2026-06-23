import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import type { SessionTranscriptView } from "../../../src/tui/adapters/sessions-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { SessionDetailScreen } from "../../../src/tui/screens/SessionDetailScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withTranscript = (
  loadTranscript: (panelName: string) => Promise<SessionTranscriptView | undefined>,
): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  sessions: { loadList: async () => [], loadTranscript },
});

describe("SessionDetailScreen", () => {
  it("renders sanitized transcript headers and rows", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withTranscript(async () => ({
          panelName: "Acme\u001B[31m",
          topic: "Launch\nTiming",
          prompt: "Should we launch?\u001B[32m",
          status: "completed\u001B[33m",
          lines: [
            { speaker: "CTO\u001B[34m", round: 1, content: "hi\u001B[31m", kind: "expert" },
            {
              speaker: "Moderator",
              round: 2,
              content: "second\nline",
              kind: "moderator",
            },
          ],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/sessions/p1", state: { panelName: "Acme" } }]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Acme");
    expect(lastFrame()).toContain("Launch Timing");
    expect(lastFrame()).toContain("Prompt: Should we launch?");
    expect(lastFrame()).toContain("Status: completed");
    expect(lastFrame()).toContain("[r1] CTO: hi");
    expect(lastFrame()).toContain("[r2] Moderator: second line");
    expect(lastFrame()).not.toContain("\u001B[31m");
    expect(lastFrame()).not.toContain("\u001B[32m");
    expect(lastFrame()).not.toContain("\u001B[34m");
    expect(lastFrame()).not.toContain("second\nline");
  });

  it("renders not found when the transcript loader returns undefined", async () => {
    const { lastFrame } = render(
      <DataProvider value={withTranscript(async () => undefined)}>
        <MemoryRouter initialEntries={[{ pathname: "/sessions/p1", state: { panelName: "Acme" } }]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/not found/i);
  });

  it("renders not found when router state has no panelName", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withTranscript(async () => {
          throw new Error("loader should not run without panelName");
        })}
      >
        <MemoryRouter initialEntries={["/sessions/p1"]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/not found/i);
  });

  it("renders an empty transcript message", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withTranscript(async () => ({
          panelName: "Acme",
          topic: "",
          prompt: "Discuss",
          status: "running",
          lines: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/sessions/p1", state: { panelName: "Acme" } }]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No turns/i);
  });
});

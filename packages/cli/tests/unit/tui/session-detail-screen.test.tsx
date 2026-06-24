import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
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

function ConcludeProbe(): React.ReactElement {
  const location = useLocation();
  const state = location.state as { readonly panelName?: string } | null;
  return <Text>CONCLUDE {state?.panelName ?? ""}</Text>;
}

function ExportProbe(): React.ReactElement {
  const location = useLocation();
  const state = location.state as { readonly panelName?: string } | null;
  return <Text>EXPORT {state?.panelName ?? ""}</Text>;
}

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

  it("renders a no-transcript message when the loader returns undefined", async () => {
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

    expect(lastFrame()).toMatch(/No transcript available/i);
  });

  it("renders a no-transcript message when router state has no panelName", async () => {
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

    expect(lastFrame()).toMatch(/No transcript available/i);
  });

  it("renders an error state when the transcript loader rejects", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withTranscript(async () => {
          throw new Error("db blew up");
        })}
      >
        <MemoryRouter initialEntries={[{ pathname: "/sessions/p1", state: { panelName: "Acme" } }]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/Failed to load session/i);
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

  it("navigates to the conclusion screen with the panel name when c is pressed", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withTranscript(async () => ({
          panelName: "Acme",
          topic: "",
          prompt: "Decide launch timing",
          status: "completed",
          lines: [{ speaker: "moderator", round: 1, content: "Welcome", kind: "moderator" }],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/sessions/p1", state: { panelName: "Acme" } }]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
            <Route path="/sessions/:id/conclude" element={<ConcludeProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    // The conclude action must be discoverable from the detail screen.
    expect(lastFrame()).toMatch(/c\b.*conclude/i);

    stdin.write("c");
    await flush();

    // Navigated to the conclude route, threading the panel name through state.
    expect(lastFrame()).toContain("CONCLUDE Acme");
  });

  it("navigates to the export overlay with the panel name when x is pressed", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withTranscript(async () => ({
          panelName: "Acme",
          topic: "",
          prompt: "Decide launch timing",
          status: "completed",
          lines: [{ speaker: "moderator", round: 1, content: "Welcome", kind: "moderator" }],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/sessions/p1", state: { panelName: "Acme" } }]}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetailScreen theme={theme} isActive />} />
            <Route path="/sessions/:id/export" element={<ExportProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    // The export action must be discoverable from the detail screen.
    expect(lastFrame()).toMatch(/x\b.*export/i);

    stdin.write("x");
    await flush();

    // Navigated to the export route, threading the panel name through state.
    expect(lastFrame()).toContain("EXPORT Acme");
  });
});

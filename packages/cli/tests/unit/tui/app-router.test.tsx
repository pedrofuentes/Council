import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { ExpertListItem } from "../../../src/tui/adapters/experts-data.js";
import type { PanelListItem } from "../../../src/tui/adapters/panels-data.js";
import type {
  SessionListItem,
  SessionTranscriptView,
} from "../../../src/tui/adapters/sessions-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] };
const flush = async (stdin?: { write: (s: string) => void }, input?: string): Promise<void> => {
  stdin?.write(input ?? "");
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};
const withPanels = (
  loadList: () => Promise<readonly PanelListItem[]> = async () => [],
): TuiDataSources => ({
  panels: { loadList, loadDetail: async () => undefined },
});
const withExperts = (
  loadList: () => Promise<readonly ExpertListItem[]> = async () => [],
): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  experts: { loadList, loadDetail: async () => undefined },
});
const withSessions = (
  loadList: () => Promise<readonly SessionListItem[]> = async () => [],
  loadTranscript: (panelName: string) => Promise<SessionTranscriptView | undefined> = async () =>
    undefined,
): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  sessions: { loadList, loadTranscript },
});

describe("AppRouter", () => {
  it("renders the Panels empty state on the /panels route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels()}>
        <MemoryRouter initialEntries={["/panels"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/No panels/i);
  });

  it("renders the Experts empty state on the /experts route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExperts()}>
        <MemoryRouter initialEntries={["/experts"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/No experts/i);
  });

  it("renders the Chats placeholder on the /chats route", () => {
    const { lastFrame } = render(
      <MemoryRouter initialEntries={["/chats"]}>
        <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
      </MemoryRouter>,
    );
    expect(lastFrame()).toContain("Chats");
    expect(lastFrame()).toContain("Coming soon");
  });

  it("focuses the nav with Tab and navigates to the chosen section on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider value={withPanels()}>
        <CouncilTUI homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
      </DataProvider>,
    );
    // default focus is main (Home route). Tab → focus nav.
    await flush(stdin, "\t");
    // nav cursor starts on the active item (home, index 0). Move down to Panels (index 1) and Enter.
    await flush(stdin, "j");
    await flush(stdin, "\r");
    await flush();
    expect(lastFrame()).toMatch(/No panels/i);
  });

  it("returns to the list on Escape from a detail route instead of exiting", async () => {
    const value: TuiDataSources = {
      panels: {
        loadList: async () => [],
        loadDetail: async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }),
      },
    };
    const { stdin, lastFrame } = render(
      <DataProvider value={value}>
        <MemoryRouter
          initialEntries={["/panels", { pathname: "/panels/acme", state: { source: "saved" } }]}
          initialIndex={1}
        >
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    // On the detail route the Members header is shown.
    expect(lastFrame()).toContain("Members");
    // A lone Esc needs a real-timer wait (Ink buffers it behind a disambiguation timeout).
    stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 140));
    await flush();
    // Back on the panels list (navigate(-1)); the app did NOT exit.
    expect(lastFrame()).toMatch(/No panels/i);
  });

  it("wires the session detail route so activating a session row is not blank", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withSessions(
          async () => [
            {
              panelId: "p1",
              panelName: "Acme",
              topic: "",
              debateCount: 1,
              turnCount: 2,
              latestStatus: "completed",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          async () => ({
            panelName: "Acme",
            topic: "",
            prompt: "Decide launch timing",
            status: "completed",
            lines: [{ speaker: "moderator", round: 1, content: "Welcome", kind: "moderator" }],
          }),
        )}
      >
        <MemoryRouter initialEntries={["/sessions"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    // The sessions list renders the panel name.
    expect(lastFrame()).toContain("Acme");
    // Activating the row navigates to /sessions/:id, which AppRouter must render.
    await flush(stdin, "\r");
    expect(lastFrame()).toContain("Decide launch timing");
    expect(lastFrame()).toContain("[r1] moderator: Welcome");
  });
});

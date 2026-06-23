import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { PanelListItem } from "../../../src/tui/adapters/panels-data.js";
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
  panels: { loadList },
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
});

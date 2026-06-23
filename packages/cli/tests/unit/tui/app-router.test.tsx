import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] };
const flush = async (stdin: { write: (s: string) => void } | undefined, s: string): Promise<void> => {
  stdin?.write(s);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("AppRouter", () => {
  it("renders the Panels placeholder on the /panels route", () => {
    const { lastFrame } = render(
      <MemoryRouter initialEntries={["/panels"]}>
        <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
      </MemoryRouter>,
    );
    expect(lastFrame()).toContain("Panels");
  });

  it("focuses the nav with Tab and navigates to the chosen section on Enter", async () => {
    const { stdin, lastFrame } = render(<CouncilTUI homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />);
    // default focus is main (Home route). Tab → focus nav.
    await flush(stdin, "\t");
    // nav cursor starts on the active item (home, index 0). Move down to Panels (index 1) and Enter.
    await flush(stdin, "j");
    await flush(stdin, "\r");
    expect(lastFrame()).toContain("Panels");
  });
});

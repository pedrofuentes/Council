import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { HomeData } from "../../../src/tui/adapters/home-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";

const homeData: HomeData = {
  counts: { sessions: 1, experts: 1, panels: 1 },
  recent: [{ id: "s1", title: "Build vs buy", when: "2d", status: "convened" }],
};

const dataSources: TuiDataSources = {
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  experts: { loadList: async () => [], loadDetail: async () => undefined },
  sessions: { loadList: async () => [], loadTranscript: async () => undefined },
};

interface TestStdin {
  readonly write: (input: string) => void;
}

const flush = async (stdin?: TestStdin, input?: string): Promise<void> => {
  stdin?.write(input ?? "");
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const renderTui = (): ReturnType<typeof render> =>
  render(
    <DataProvider value={dataSources}>
      <CouncilTUI
        homeData={homeData}
        model="gpt-4o"
        env={{ NO_COLOR: "1" }}
        initialColumns={140}
        initialRows={40}
      />
    </DataProvider>,
  );

describe("command palette wiring", () => {
  it("opens the palette with Ctrl-K", async () => {
    const { stdin, lastFrame, unmount } = renderTui();

    await flush(stdin, "\u000b");

    expect(lastFrame()).toContain("> ");
    expect(lastFrame()).toContain("Go to Panels");
    unmount();
  });

  it("dispatches navigation commands from the palette", async () => {
    const { stdin, lastFrame, unmount } = renderTui();

    await flush(stdin, "\u000b");
    await flush(stdin, "panels");
    await flush(stdin, "\r");
    await flush();

    expect(lastFrame()).toMatch(/No panels/i);
    unmount();
  });

  it("dispatches the help command from the palette", async () => {
    const { stdin, lastFrame, unmount } = renderTui();

    await flush(stdin, "\u000b");
    await flush(stdin, "Help");
    await flush(stdin, "\r");
    await flush();

    expect(lastFrame()).toContain("Keyboard shortcuts");
    unmount();
  });

  it("closes the palette with Escape without navigating or exiting", async () => {
    const { stdin, lastFrame, unmount } = renderTui();

    await flush();
    expect(lastFrame()).toContain("Build vs buy");
    await flush(stdin, "\u000b");
    expect(lastFrame()).toContain("> ");
    stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 120));
    await flush();

    expect(lastFrame()).not.toContain("> ");
    expect(lastFrame()).toContain("Build vs buy");
    unmount();
  });
});

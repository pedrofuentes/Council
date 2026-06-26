import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { HomeData } from "../../../src/tui/adapters/home-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";

const homeData: HomeData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] };

const flush = async (stdin?: { write: (s: string) => void }, input?: string): Promise<void> => {
  stdin?.write(input ?? "");
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const renderAt = (entries: readonly unknown[], value: TuiDataSources) =>
  render(
    <DataProvider value={value}>
      <InputCaptureProvider>
        <MemoryRouter initialEntries={entries as never}>
          <AppRouter homeData={homeData} model="gpt-4o" env={{ NO_COLOR: "1" }} initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </InputCaptureProvider>
    </DataProvider>,
  );

const renderTui = (): ReturnType<typeof render> =>
  render(
    <DataProvider value={{ panels: { loadList: async () => [], loadDetail: async () => undefined } }}>
      <CouncilTUI homeData={homeData} model="gpt-4o" env={{ NO_COLOR: "1" }} initialColumns={120} initialRows={30} />
    </DataProvider>,
  );

describe("contextual footer action bar", () => {
  it("shows the current route's actions on a panel-detail route, not the old static list", async () => {
    const value: TuiDataSources = {
      panels: {
        loadList: async () => [],
        loadDetail: async () => ({
          name: "strategy",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }),
      },
    };
    const { lastFrame, unmount } = renderAt(["/panels/strategy"], value);
    await flush();
    const frame = lastFrame() ?? "";
    // Contextual actions for /panels/:name (shortcutsForRoute).
    expect(frame).toContain("Chat");
    expect(frame).toContain("Convene");
    expect(frame).toContain("Edit members");
    expect(frame).toContain("Delete");
    // The old global static footer must be gone from the left hint area.
    expect(frame).not.toContain("Toggle");
    expect(frame).not.toContain("Quit");
    unmount();
  });

  it("falls back to a minimal nav hint on a route with no contextual legend", async () => {
    const value: TuiDataSources = {
      sessions: { loadList: async () => [], loadTranscript: async () => undefined },
    };
    const { lastFrame, unmount } = renderAt(["/sessions"], value);
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Move");
    expect(frame).toContain("Open");
    expect(frame).not.toContain("Toggle");
    unmount();
  });

  it("keeps the global ^K Palette and ? Help affordances on the right", async () => {
    const value: TuiDataSources = {
      sessions: { loadList: async () => [], loadTranscript: async () => undefined },
    };
    const { lastFrame, unmount } = renderAt(["/sessions"], value);
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("^K");
    expect(frame).toContain("Palette");
    expect(frame).toContain("Help");
    unmount();
  });
});

describe("footer mode badge reflects real state", () => {
  it("shows MAIN when focus is on the main pane (not the constant NAV)", async () => {
    const { lastFrame, unmount } = renderTui();
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MAIN");
    unmount();
  });

  it("shows PALETTE when the command palette is open", async () => {
    const { stdin, lastFrame, unmount } = renderTui();
    await flush(stdin, "\u000b");
    expect(lastFrame() ?? "").toContain("PALETTE");
    unmount();
  });

  it("shows HELP when the help overlay is open", async () => {
    const { stdin, lastFrame, unmount } = renderTui();
    await flush(stdin, "?");
    expect(lastFrame() ?? "").toContain("HELP");
    unmount();
  });
});

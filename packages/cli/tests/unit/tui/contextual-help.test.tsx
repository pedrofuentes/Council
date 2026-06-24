import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";

import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

describe("contextual help overlay (?)", () => {
  it("shows the CURRENT screen's shortcuts when ? is pressed on the panel detail route", async () => {
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
    const { stdin, lastFrame } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter
            initialEntries={[{ pathname: "/panels/strategy", state: { source: "saved" } }]}
          >
            <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );
    await flush();
    stdin.write("?");
    await flush();

    const frame = lastFrame() ?? "";
    // contextual section surfaces the panel-detail bindings
    expect(frame).toContain("This screen");
    expect(frame).toContain("Edit members");
    expect(frame).toContain("Convene");
    // the global list is still present
    expect(frame).toContain("Keyboard shortcuts");
  });

  it("shows the expert-detail shortcuts on the /experts/:slug route", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      experts: {
        loadList: async () => [],
        loadDetail: async () => ({
          slug: "cto",
          displayName: "Chief Technology Officer",
          role: "Tech",
          kind: "persona",
          epistemicStance: "evidence-led",
          expertise: { weightedEvidence: [], referenceCases: [], notExpertIn: [] },
          panels: [],
        }),
      },
      expertMemory: {
        load: async () => ({
          hasMemory: false,
          communicationStyle: "",
          decisionPatterns: [],
          biases: [],
          vocabulary: [],
          epistemicStance: "",
          documentCount: 0,
          totalWords: 0,
          lastUpdated: "",
          documents: { count: 0, totalWords: 0, filenames: [] },
        }),
      },
    } as unknown as TuiDataSources;
    const { stdin, lastFrame } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/experts/cto"]}>
            <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );
    await flush();
    stdin.write("?");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("This screen");
    expect(frame).toContain("Documents");
    expect(frame).toContain("Train");
  });

  it("shows ONLY the global list (no contextual section) on a route without shortcuts", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      chats: { list: async () => [] },
    } as unknown as TuiDataSources;
    const { stdin, lastFrame } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/chats"]}>
            <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );
    await flush();
    stdin.write("?");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Keyboard shortcuts");
    expect(frame).not.toContain("This screen");
  });
});

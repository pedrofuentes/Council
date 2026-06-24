import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import type { ExpertDetailView } from "../../../src/tui/adapters/experts-data.js";
import type { ExpertMemoryView } from "../../../src/tui/adapters/expert-memory.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { ExpertDetailScreen } from "../../../src/tui/screens/ExpertDetailScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const detailFor = (overrides: Partial<ExpertDetailView> = {}): ExpertDetailView => ({
  slug: "cto",
  displayName: "CTO",
  role: "Technology",
  kind: "persona",
  epistemicStance: "Evidence first",
  expertise: { weightedEvidence: [], referenceCases: [], notExpertIn: [] },
  panels: [],
  ...overrides,
});

const memoryFor = (overrides: Partial<ExpertMemoryView> = {}): ExpertMemoryView => ({
  hasMemory: true,
  communicationStyle: "Direct and concise",
  decisionPatterns: ["Weighs tradeoffs"],
  biases: ["Optimism bias"],
  vocabulary: ["leverage"],
  epistemicStance: "Evidence-weighted",
  documentCount: 3,
  totalWords: 1234,
  lastUpdated: "2026-06-23T00:00:00.000Z",
  documents: { count: 2, totalWords: 150, filenames: ["roadmap.md", "vision.md"] },
  ...overrides,
});

const noMemory: ExpertMemoryView = {
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
};

const withSources = (
  detail: ExpertDetailView | undefined,
  load: (slug: string) => Promise<ExpertMemoryView | undefined>,
): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  experts: { loadList: async () => [], loadDetail: async () => detail },
  expertMemory: { load },
});

const renderScreen = (sources: TuiDataSources): ReturnType<typeof render> =>
  render(
    <DataProvider value={sources}>
      <MemoryRouter initialEntries={[{ pathname: "/experts/cto" }]}>
        <Routes>
          <Route path="/experts/:slug" element={<ExpertDetailScreen theme={theme} isActive />} />
        </Routes>
      </MemoryRouter>
    </DataProvider>,
  );

describe("ExpertDetailScreen memory section", () => {
  it("renders the learned memory for a persona expert and sanitizes the sink", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "persona" }), async () =>
        memoryFor({ communicationStyle: "Direct\u001B[31m and concise" }),
      ),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Memory");
    expect(frame).toContain("Communication Style");
    expect(frame).toContain("Direct and concise");
    expect(frame).toContain("Weighs tradeoffs");
    expect(frame).toContain("Optimism bias");
    expect(frame).toContain("leverage");
    expect(frame).toContain("1234");
    expect(frame).toContain("Documents");
    expect(frame).not.toContain("\u001B[31m");
  });

  it("renders an empty state when the persona expert has no learned memory", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "persona" }), async () => noMemory),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/no .*memory/i);
    expect(frame).not.toContain("Communication Style");
  });

  it("does not render the memory section for a generic expert", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "generic" }), async () => memoryFor()),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Technology [generic]");
    expect(frame).not.toContain("Communication Style");
  });
});

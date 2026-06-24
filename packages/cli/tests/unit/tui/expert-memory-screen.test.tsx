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

describe("ExpertDetailScreen memory section collapses line-control injection", () => {
  // A run of CR, U+2028 line separator, TAB and LF. `stripControlChars`
  // deliberately PRESERVES every one of these, so a sink that only strips
  // control chars lets untrusted memory forge rows / CR-overwrite labels.
  // `toSingleLineDisplay` collapses the whole run to a single space.
  const SEP = "\r\u2028\t\n";

  it("collapses CR/LF/TAB/U+2028 in communicationStyle prose", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "persona" }), async () =>
        memoryFor({ communicationStyle: `commStyleAlpha${SEP}commStyleOmega` }),
      ),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("commStyleAlpha commStyleOmega");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("commStyleAlpha\r");
  });

  it("collapses CR/LF/TAB/U+2028 in a decisionPatterns list item", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "persona" }), async () =>
        memoryFor({ decisionPatterns: [`decisionAlpha${SEP}decisionOmega`] }),
      ),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("decisionAlpha decisionOmega");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("decisionAlpha\r");
  });

  it("collapses CR/LF/TAB/U+2028 in a biases list item", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "persona" }), async () =>
        memoryFor({ biases: [`biasAlpha${SEP}biasOmega`] }),
      ),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("biasAlpha biasOmega");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("biasAlpha\r");
  });

  it("collapses CR/LF/TAB/U+2028 in a vocabulary list item", async () => {
    const { lastFrame } = renderScreen(
      withSources(detailFor({ kind: "persona" }), async () =>
        memoryFor({ vocabulary: [`vocabAlpha${SEP}vocabOmega`] }),
      ),
    );

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("vocabAlpha vocabOmega");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("vocabAlpha\r");
  });
});

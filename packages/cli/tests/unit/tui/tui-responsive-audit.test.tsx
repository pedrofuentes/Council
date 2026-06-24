import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MemoryRouter, type InitialEntry } from "react-router";

import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = {
  counts: { sessions: 0, experts: 0, panels: 0 },
  recent: [],
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

// Color introducers emitted exclusively by our SemanticTheme (resolveTheme):
// cyan=accent, red=error, yellow=warn, green=success. Ink's own `inverse`/
// `dimColor` props use 7m/2m and are intentionally NOT in this list, so the
// assertion is not fooled by Ink's testing-harness highlight ANSI.
const THEME_COLOR_CODES = ["\u001b[36m", "\u001b[31m", "\u001b[33m", "\u001b[32m"];
function leaksThemeColor(frame: string): boolean {
  return THEME_COLOR_CODES.some((code) => frame.includes(code));
}

// A comprehensive set of benign fakes so every audited screen mounts and renders
// real content (rather than only an error state) at the rail/expanded widths.
const auditSources = {
  panels: {
    loadList: async () => [
      { name: "Acme", description: "Strategy panel", memberCount: 1, source: "saved" },
    ],
    loadDetail: async () => ({
      name: "Acme",
      description: "Strategy panel",
      source: "saved",
      members: [
        { slug: "cto", displayName: "Chief Technology Officer", role: "Tech", kind: "generic" },
      ],
      missing: [],
    }),
  },
  experts: {
    loadList: async () => [
      {
        slug: "cto",
        displayName: "Chief Technology Officer",
        role: "Tech",
        kind: "persona",
        panelCount: 0,
      },
    ],
    loadDetail: async () => ({
      slug: "cto",
      displayName: "Chief Technology Officer",
      role: "Tech",
      kind: "persona",
      epistemicStance: "evidence-led",
      expertise: { weightedEvidence: ["a"], referenceCases: [], notExpertIn: [] },
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
  sessions: {
    loadList: async () => [
      {
        panelId: "p1",
        panelName: "Acme",
        topic: "",
        debateCount: 1,
        turnCount: 1,
        latestStatus: "completed",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    loadTranscript: async () => ({
      panelName: "Acme",
      topic: "Launch timing",
      prompt: "Decide launch timing",
      status: "completed",
      lines: [{ speaker: "moderator", round: 1, content: "Welcome", kind: "moderator" }],
    }),
  },
  chats: {
    list: async () => [
      {
        id: "c1",
        targetType: "expert",
        targetSlug: "cto",
        title: "Roadmap",
        when: "2h",
        status: "active",
      },
    ],
  },
  settings: {
    load: async () => [
      {
        path: "defaults.model",
        section: "Defaults",
        label: "Default model",
        kind: "string",
        value: "gpt-4o",
      },
    ],
    save: async () => undefined,
  },
  onboarding: {
    load: async () => ({
      isFirstRun: true,
      usedFallback: false,
      models: [{ id: "claude-sonnet-4.5", label: "claude-sonnet-4.5", recommended: true }],
    }),
    complete: async () => undefined,
  },
  export: {
    render: async () => "# Export preview\nLine one",
    writeFile: async () => undefined,
  },
  convene: {
    estimateCost: async () => ({ experts: 2, rounds: 3, estimatedPremiumRequests: 6 }),
    streamDebate: async () => ({ debateId: "d1", reason: "completed" }),
  },
  conclude: {
    synthesize: async () => ({
      panelName: "Acme",
      topic: "Launch timing",
      consensus: ["Ship in Q3"],
      tensions: [],
      decisionMatrix: [],
      recommendation: "Adopt a phased rollout",
      confidence: "medium",
      warnings: [],
    }),
  },
} as unknown as TuiDataSources;

interface AuditRoute {
  readonly name: string;
  readonly entry: InitialEntry;
}

// Representative set spanning the 9.5–9.9 surfaces (lists, detail, export,
// conclusion, onboarding, settings, convene, chat-adjacent).
const ROUTES: readonly AuditRoute[] = [
  { name: "home", entry: "/" },
  { name: "panels list", entry: "/panels" },
  { name: "panel detail", entry: { pathname: "/panels/Acme", state: { source: "saved" } } },
  { name: "experts list", entry: "/experts" },
  { name: "expert detail (memory)", entry: "/experts/cto" },
  { name: "sessions list", entry: "/sessions" },
  { name: "session detail", entry: { pathname: "/sessions/p1", state: { panelName: "Acme" } } },
  {
    name: "session export",
    entry: { pathname: "/sessions/p1/export", state: { panelName: "Acme" } },
  },
  {
    name: "session conclude",
    entry: { pathname: "/sessions/p1/conclude", state: { panelName: "Acme" } },
  },
  { name: "chats list", entry: "/chats" },
  { name: "onboarding", entry: "/onboarding" },
  { name: "settings", entry: "/settings" },
  { name: "convene prompt", entry: "/convene/Acme" },
];

interface AuditWidth {
  readonly label: string;
  readonly columns: number;
  readonly narrow: boolean;
}

const WIDTHS: readonly AuditWidth[] = [
  { label: "tooNarrow (<60)", columns: 50, narrow: true },
  { label: "rail (80)", columns: 80, narrow: false },
  { label: "expanded (130)", columns: 130, narrow: false },
];

async function renderRoute(
  entry: InitialEntry,
  columns: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { lastFrame, unmount } = render(
    <InputCaptureProvider>
      <DataProvider value={auditSources}>
        <MemoryRouter initialEntries={[entry]}>
          <AppRouter
            homeData={homeData}
            model="gpt-4o"
            env={env}
            initialColumns={columns}
            initialRows={30}
          />
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
  await flush();
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe("responsive + NO_COLOR audit (9.5–9.9 screens)", () => {
  for (const width of WIDTHS) {
    for (const route of ROUTES) {
      it(`${route.name} renders under NO_COLOR at ${width.label} without leaking theme ANSI`, async () => {
        const frame = await renderRoute(route.entry, width.columns, { NO_COLOR: "1" });
        // renders without throwing
        expect(typeof frame).toBe("string");
        // our theme honors NO_COLOR — no cyan/red/yellow/green introducers
        expect(leaksThemeColor(frame)).toBe(false);
        if (width.narrow) {
          // below 60 cols the AppShell guard must take over
          expect(frame.toLowerCase()).toContain("too narrow");
        } else {
          // above the floor the guard must NOT appear
          expect(frame.toLowerCase()).not.toContain("too narrow");
        }
      });
    }
  }

  it("positive control: the theme DOES emit cyan accent when color is enabled", async () => {
    // Proves the NO_COLOR assertion above is discriminating, not vacuous: the
    // same panels screen emits our cyan accent (\u001b[36m) when color is on.
    const colored = await renderRoute("/panels", 130, {});
    expect(colored.includes("\u001b[36m")).toBe(true);
    const plain = await renderRoute("/panels", 130, { NO_COLOR: "1" });
    expect(plain.includes("\u001b[36m")).toBe(false);
  });
});

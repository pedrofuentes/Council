import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ExpertListItem } from "../../../src/tui/adapters/experts-data.js";
import type { PanelListItem } from "../../../src/tui/adapters/panels-data.js";
import type {
  SessionListItem,
  SessionTranscriptView,
} from "../../../src/tui/adapters/sessions-data.js";
import type { ChatListItem } from "../../../src/tui/adapters/chats-data.js";
import type { SettingsFieldState } from "../../../src/tui/adapters/config-settings.js";
import type { ExpertAuthoringSource } from "../../../src/tui/adapters/expert-authoring.js";
import type { ExpertDocumentsDataSource } from "../../../src/tui/adapters/expert-documents.js";
import type { ExpertTrainingDataSource } from "../../../src/tui/adapters/expert-training.js";
import type { PanelAuthoringDataSource } from "../../../src/tui/adapters/panel-authoring.js";
import type { PanelComposeDataSource } from "../../../src/tui/adapters/panel-compose.js";
import type { ChatEngineSource } from "../../../src/tui/adapters/chat-engine-session.js";
import type { ChatSessionDataSource } from "../../../src/tui/adapters/chat-session.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";
import type { ConveneDataSource } from "../../../src/tui/adapters/convene.js";
import type { ConcludeDataSource, ConclusionView } from "../../../src/tui/adapters/conclude.js";

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
const withPanelCreate = (): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    experts: {
      loadList: async () => [
        {
          slug: "cto",
          displayName: "Chief Technology Officer",
          role: "Technology strategy",
          kind: "generic",
          panelCount: 0,
        },
      ],
      loadDetail: async () => undefined,
    },
    panelAuthoring: {
      create: async () => undefined,
      setMembers: async () => undefined,
      countRetainedDebates: async () => 0,
      delete: async () => undefined,
    } satisfies PanelAuthoringDataSource,
  }) as TuiDataSources;

const withPanelCompose = (): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    panelCompose: {
      compose: async () => ({
        name: "Composed Panel",
        description: null,
        experts: [],
        definition: { name: "composed-panel", experts: [] },
      }),
      persist: async () => ({ panelName: "composed-panel" }),
    } satisfies PanelComposeDataSource,
  }) as TuiDataSources;

const withPanelMembers = (): TuiDataSources =>
  ({
    panels: {
      loadList: async () => [],
      loadDetail: async () => ({
        name: "strategy",
        description: "",
        source: "saved",
        members: [
          {
            slug: "cto",
            displayName: "Chief Technology Officer",
            role: "Technology strategy",
            kind: "generic",
          },
        ],
        missing: [],
      }),
    },
    experts: {
      loadList: async () => [
        {
          slug: "cto",
          displayName: "Chief Technology Officer",
          role: "Technology strategy",
          kind: "generic",
          panelCount: 1,
        },
      ],
      loadDetail: async () => undefined,
    },
    panelAuthoring: {
      create: async () => undefined,
      setMembers: async () => undefined,
      countRetainedDebates: async () => 0,
      delete: async () => undefined,
    } satisfies PanelAuthoringDataSource,
  }) as TuiDataSources;
const withSessions = (
  loadList: () => Promise<readonly SessionListItem[]> = async () => [],
  loadTranscript: (panelName: string) => Promise<SessionTranscriptView | undefined> = async () =>
    undefined,
): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  sessions: { loadList, loadTranscript },
});

const withConvenePrompt = (): TuiDataSources => {
  const convene: ConveneDataSource = {
    estimateCost: async () => ({ experts: 2, rounds: 3, estimatedPremiumRequests: 6 }),
    streamDebate: async () => ({ debateId: undefined, reason: "completed" }),
  };
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    convene,
  } as TuiDataSources;
};

const withConclude = (view: ConclusionView): TuiDataSources => {
  const conclude: ConcludeDataSource = {
    synthesize: async () => view,
  };
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    conclude,
  } as TuiDataSources;
};

const withExport = (): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    export: {
      render: async () => "# Export preview\n> hello",
      writeFile: async () => undefined,
    },
  }) as TuiDataSources;

const withSettings = (load: () => Promise<readonly SettingsFieldState[]>): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    settings: { load, save: async () => undefined },
  }) as TuiDataSources;
const withPanelChat = (): TuiDataSources => {
  const chat: ChatSessionDataSource = {
    loadHistory: async () => ({ session: undefined, turns: [] }),
    ensureSession: async () => ({ id: "session-1" }),
    route: (input, availableSlugs) => ({
      type: "general",
      targetSlugs: availableSlugs,
      content: input.trim(),
    }),
    persistTurn: async () => undefined,
  };
  const chatEngine: ChatEngineSource = {
    open: async () => {
      throw new Error("unexpected expert open");
    },
    openPanel: async () => ({
      members: [{ slug: "cto", expertId: "expert-cto" }],
      send: () => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "message.complete", expertId: "expert-cto", response: { latencyMs: 1 } };
        },
      }),
      close: async () => undefined,
    }),
  };
  return {
    panels: {
      loadList: async () => [],
      loadDetail: async () => ({
        name: "strategy",
        description: "",
        source: "saved",
        members: [{ slug: "cto", displayName: "CTO", role: "Tech", kind: "generic" }],
        missing: [],
      }),
    },
    chat,
    chatEngine,
  } as TuiDataSources;
};

const withExpertChat = (): TuiDataSources => {
  const chat: ChatSessionDataSource = {
    loadHistory: async () => ({ session: undefined, turns: [] }),
    ensureSession: async () => ({ id: "session-1" }),
    route: (input) => ({ type: "general", targetSlugs: [], content: input.trim() }),
    persistTurn: async () => undefined,
  };
  const chatEngine: ChatEngineSource = {
    open: async () => ({
      expertId: "expert-ulid",
      send: () => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "message.complete", expertId: "expert-ulid", response: { latencyMs: 1 } };
        },
      }),
      close: async () => undefined,
    }),
  };
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    chat,
    chatEngine,
  } as TuiDataSources;
};
const withExpertAuthoring = (): TuiDataSources => {
  const authoring: ExpertAuthoringSource = {
    loadForEdit: async (slug) =>
      slug === "cto"
        ? {
            slug: "cto",
            displayName: "Chief Technology Officer",
            role: "Technology strategy",
            weightedEvidence: "architecture reviews",
            referenceCases: "platform scaling",
            notExpertIn: "tax law",
            epistemicStance: "evidence first",
            kind: "generic",
            personaDescription: "",
            model: "gpt-4o",
          }
        : undefined,
    create: async (values) => ({
      ok: true,
      definition: {
        slug: values.slug.trim(),
        displayName: values.displayName.trim(),
        role: values.role.trim(),
        expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "stance",
        kind: values.kind,
      },
    }),
    update: async (_slug, values) => ({
      ok: true,
      definition: {
        slug: values.slug.trim(),
        displayName: values.displayName.trim(),
        role: values.role.trim(),
        expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "stance",
        kind: values.kind,
      },
    }),
    remove: async () => ({ affectedPanels: [] }),
    affectedPanels: async () => [],
  };
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    expertAuthoring: authoring,
  };
};
const withExpertTraining = (): TuiDataSources => {
  const training: ExpertTrainingDataSource = {
    train: async () => ({
      filesProcessed: 0,
      filesFailed: 0,
      filesSkipped: 0,
      filesNeedingReview: 0,
      totalWords: 0,
      profileUpdated: false,
      profileError: null,
    }),
  };
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    training,
  };
};

const withExpertDocuments = (): TuiDataSources => {
  const documents: ExpertDocumentsDataSource = {
    list: async () => [
      {
        id: "doc-1",
        filename: "roadmap.md",
        sizeBytes: 42,
        wordCount: 7,
        status: "processed",
        processedAt: "2026-06-23T00:00:00.000Z",
      },
    ],
    remove: async () => ({ ftsCleanupFailed: false }),
  };
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    documents,
  };
};

describe("AppRouter", () => {
  it("threads onOnboardingComplete to the onboarding route so completing restarts the session", async () => {
    const onOnboardingComplete = vi.fn();
    const complete = vi.fn(async () => undefined);
    const sources = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      onboarding: {
        load: async () => ({
          isFirstRun: true,
          usedFallback: false,
          models: [{ id: "claude-sonnet-4.5", label: "claude-sonnet-4.5", recommended: true }],
        }),
        complete,
      },
    } as unknown as TuiDataSources;
    const { stdin } = render(
      <InputCaptureProvider>
        <DataProvider value={sources}>
          <MemoryRouter initialEntries={["/onboarding"]}>
            <AppRouter
              homeData={homeData}
              model="gpt-4o"
              onOnboardingComplete={onOnboardingComplete}
              initialColumns={120}
              initialRows={30}
            />
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(complete).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(onOnboardingComplete).toHaveBeenCalled();
  });

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

  it("renders the panel compose screen on the literal /panels/compose route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanelCompose()}>
        <MemoryRouter initialEntries={["/panels/compose"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/Auto-compose panel/i);
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

  it("renders the ConvenePromptScreen on the convene prompt route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withConvenePrompt()}>
        <MemoryRouter initialEntries={["/convene/acme"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Convene acme");
    expect(lastFrame()).toContain("Topic:");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("shows a depth- and entity-aware breadcrumb on the convene route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withConvenePrompt()}>
        <MemoryRouter initialEntries={["/convene/acme"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Panels › acme › Convene");
    expect(lastFrame()).not.toContain("🏛 Council");
  });

  it("renders the chats list screen on the /chats route", async () => {
    const chats: readonly ChatListItem[] = [
      {
        id: "c1",
        targetType: "expert",
        targetSlug: "cto",
        title: "Roadmap review",
        when: "2h",
        status: "active",
      },
    ];
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      chats: { list: async () => chats },
    } as TuiDataSources;
    const { lastFrame } = render(
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/chats"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toContain("Roadmap review");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the expert chat screen on the /chat/expert/:slug route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExpertChat()}>
        <MemoryRouter initialEntries={["/chat/expert/cto"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Chat with cto");
    expect(lastFrame()).toContain("Message:");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the panel chat screen on the /chat/panel/:name route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanelChat()}>
        <MemoryRouter initialEntries={["/chat/panel/strategy"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Panel chat strategy");
    expect(lastFrame()).toContain("Message:");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the Settings screen on the /settings route", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withSettings(async () => [
          {
            path: "defaults.model",
            section: "Defaults",
            label: "Default model",
            kind: "string",
            value: "gpt-4o",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/settings"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Defaults");
    expect(lastFrame()).toContain("Default model: gpt-4o");
    expect(lastFrame()).toContain("↑↓ move · Enter edit · Ctrl+S save · Esc back");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the ExpertFormScreen on the static /experts/new route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExpertAuthoring()}>
        <MemoryRouter initialEntries={["/experts/new"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Slug (required):");
    expect(lastFrame()).toContain("Kind: generic");
    expect(lastFrame()).toContain("↑↓ move · Enter edit · Ctrl+S save · Esc back");
    expect(lastFrame()).not.toContain("Expert not found");
  });

  it("renders the PanelCreateScreen on the static /panels/new route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanelCreate()}>
        <MemoryRouter initialEntries={["/panels/new"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Name:");
    expect(lastFrame()).toContain("Chief Technology Officer");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the PanelDeleteScreen on the panel delete route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanelCreate()}>
        <MemoryRouter initialEntries={["/panels/strategy/delete"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain('Delete panel "strategy"?');
    expect(lastFrame()).toContain("0 saved session");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the PanelMembersScreen on the panel members route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanelMembers()}>
        <MemoryRouter initialEntries={["/panels/strategy/members"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Members:");
    expect(lastFrame()).toContain("[x] Chief Technology Officer");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the ExpertFormScreen edit mode on the expert edit route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExpertAuthoring()}>
        <MemoryRouter initialEntries={["/experts/cto/edit"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Chief Technology Officer");
    expect(lastFrame()).toContain("Slug (required):");
    expect(lastFrame()).not.toContain("Expert not found");
  });

  it("renders the ExpertDeleteScreen on the expert delete route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExpertAuthoring()}>
        <MemoryRouter initialEntries={["/experts/cto/delete"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain('Delete expert "cto"?');
    expect(lastFrame()).toContain("Not used in any panels.");
    expect(lastFrame()).not.toContain("Expert not found");
  });

  it("renders the ExpertDocumentsScreen on the specific expert docs route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExpertDocuments()}>
        <MemoryRouter initialEntries={["/experts/cto/docs"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("roadmap.md");
    expect(lastFrame()).not.toContain("Expert not found");
  });

  it("renders the ExpertTrainScreen on the specific expert train route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExpertTraining()}>
        <MemoryRouter initialEntries={["/experts/cto/train"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Document file path:");
    expect(lastFrame()).not.toContain("Expert not found");
  });

  it("renders the OnboardingScreen on the /onboarding route", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      onboarding: {
        load: async () => ({
          isFirstRun: true,
          usedFallback: false,
          models: [{ id: "claude-sonnet-4.5", label: "claude-sonnet-4.5", recommended: true }],
        }),
        complete: async () => undefined,
      },
    } as unknown as TuiDataSources;
    const { lastFrame } = render(
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/onboarding"]}>
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/welcome to council/i);
    expect(lastFrame()).toContain("claude-sonnet-4.5");
    expect(lastFrame()).not.toContain("Coming soon");
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

  it("renders the ConclusionScreen on the /sessions/:id/conclude route", async () => {
    const view: ConclusionView = {
      panelName: "Acme",
      topic: "Launch timing",
      consensus: ["Ship in Q3"],
      tensions: ["Budget vs speed"],
      decisionMatrix: [
        {
          dimension: "Risk vs Innovation",
          stances: [{ expert: "conservative", stance: "Wait for data" }],
        },
      ],
      recommendation: "Adopt a phased rollout",
      confidence: "medium",
      warnings: [],
    };
    const { lastFrame } = render(
      <DataProvider value={withConclude(view)}>
        <MemoryRouter
          initialEntries={[{ pathname: "/sessions/p1/conclude", state: { panelName: "Acme" } }]}
        >
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    // The route must resolve to the conclusion view, not silently dead-end (#1678).
    expect(lastFrame()).toContain("Risk vs Innovation");
    expect(lastFrame()).toContain("Adopt a phased rollout");
    expect(lastFrame()).not.toContain("Coming soon");
  });

  it("renders the ExportOverlay on the /sessions/:id/export route", async () => {
    const { lastFrame } = render(
      <DataProvider value={withExport()}>
        <MemoryRouter
          initialEntries={[{ pathname: "/sessions/p1/export", state: { panelName: "Acme" } }]}
        >
          <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    // The export route must resolve to the overlay (its format picker), not a
    // silent dead-end / placeholder (known gap class #1678).
    expect(lastFrame()).toMatch(/markdown/i);
    expect(lastFrame()).not.toContain("Coming soon");
  });
});

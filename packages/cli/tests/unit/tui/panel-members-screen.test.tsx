import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ExpertListItem } from "../../../src/tui/adapters/experts-data.js";
import type { PanelAuthoringDataSource } from "../../../src/tui/adapters/panel-authoring.js";
import type { PanelDetailView } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { PanelMembersScreen } from "../../../src/tui/screens/PanelMembersScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const experts: readonly ExpertListItem[] = [
  {
    slug: "cto",
    displayName: "Chief\nTechnology\u001B[31m Officer",
    role: "Technology strategy",
    kind: "generic",
    panelCount: 1,
  },
  {
    slug: "cfo",
    displayName: "Chief Financial Officer",
    role: "Finance",
    kind: "persona",
    panelCount: 0,
  },
];

const detail: PanelDetailView = {
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
};

function PanelProbe(): React.ReactElement {
  const params = useParams();
  return <Text>DETAIL {params.name}</Text>;
}

function createAuthoring(
  setMembers: PanelAuthoringDataSource["setMembers"] = async () => undefined,
): PanelAuthoringDataSource {
  return {
    create: async () => undefined,
    setMembers,
    countRetainedDebates: async () => 0,
    delete: async () => undefined,
  };
}

function renderScreen(
  options: {
    readonly loadDetail?: (
      name: string,
      source: "saved" | "template",
    ) => Promise<PanelDetailView | undefined>;
    readonly loadList?: () => Promise<readonly ExpertListItem[]>;
    readonly panelAuthoring?: PanelAuthoringDataSource;
  } = {},
): ReturnType<typeof render> {
  const value = {
    panels: {
      loadList: async () => [],
      loadDetail: options.loadDetail ?? (async () => detail),
    },
    experts: {
      loadList: options.loadList ?? (async () => experts),
      loadDetail: async () => undefined,
    },
    panelAuthoring: options.panelAuthoring ?? createAuthoring(),
  } as TuiDataSources;

  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/panels/strategy/members"]}>
          <Routes>
            <Route
              path="/panels/:name/members"
              element={<PanelMembersScreen theme={theme} isActive />}
            />
            <Route path="/panels/:name" element={<PanelProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("PanelMembersScreen", () => {
  it("loads and renders the expert multi-select with current members pre-checked", async () => {
    const { lastFrame, unmount } = renderScreen();

    await flush();

    expect(lastFrame()).toContain("[x] Chief Technology Officer — Technology strategy [generic]");
    expect(lastFrame()).toContain("[ ] Chief Financial Officer — Finance [persona]");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("toggles experts, saves the new selection, and navigates to the panel detail route", async () => {
    const setMembers = vi.fn<
      Parameters<PanelAuthoringDataSource["setMembers"]>,
      ReturnType<PanelAuthoringDataSource["setMembers"]>
    >(async () => undefined);
    const { stdin, lastFrame, unmount } = renderScreen({
      panelAuthoring: createAuthoring(setMembers),
    });
    await flush();

    stdin.write("j");
    await flush();
    stdin.write(" ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(setMembers).toHaveBeenCalledWith("strategy", ["cto", "cfo"]);
    expect(lastFrame()).toContain("DETAIL strategy");
    unmount();
  });

  it("shows a loading state and does not save while resources are still loading", async () => {
    const setMembers = vi.fn<Parameters<PanelAuthoringDataSource["setMembers"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderScreen({
      loadDetail: async () => new Promise<PanelDetailView | undefined>(() => undefined),
      panelAuthoring: createAuthoring(setMembers),
    });
    await flush();

    stdin.write("\r");
    await flush();

    expect(lastFrame()).toMatch(/Loading/i);
    expect(setMembers).not.toHaveBeenCalled();
    unmount();
  });

  it("renders a not found state when the saved panel is missing", async () => {
    const { lastFrame, unmount } = renderScreen({ loadDetail: async () => undefined });

    await flush();

    expect(lastFrame()).toContain("Panel not found");
    unmount();
  });

  it("shows an inline error for an empty selection and does not save", async () => {
    const setMembers = vi.fn<Parameters<PanelAuthoringDataSource["setMembers"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderScreen({
      panelAuthoring: createAuthoring(setMembers),
    });
    await flush();

    stdin.write(" ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(setMembers).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Select at least one expert");
    unmount();
  });

  it("shows a sanitized inline error when saving members rejects", async () => {
    const setMembers = vi.fn<Parameters<PanelAuthoringDataSource["setMembers"]>, Promise<void>>(
      async () => {
        throw new Error("Nope\n\u001B[31mtry again");
      },
    );
    const { stdin, lastFrame, unmount } = renderScreen({
      panelAuthoring: createAuthoring(setMembers),
    });
    await flush();

    stdin.write("\r");
    await flush();

    expect(setMembers).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Nope try again");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });
});

describe("PanelMembersScreen — cancel", () => {
  it("navigates back to the previous screen on Esc when idle", async () => {
    const value = {
      panels: {
        loadList: async () => [],
        loadDetail: async () => detail,
      },
      experts: {
        loadList: async () => experts,
        loadDetail: async () => undefined,
      },
      panelAuthoring: createAuthoring(),
    } as TuiDataSources;

    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels/strategy", "/panels/strategy/members"]}>
            <Routes>
              <Route path="/panels/strategy" element={<Text>PANEL DETAIL</Text>} />
              <Route
                path="/panels/:name/members"
                element={<PanelMembersScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    expect(lastFrame()).toContain("Members:");

    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).toContain("PANEL DETAIL");
    unmount();
  });
});

describe("PanelMembersScreen — cancel during in-flight save", () => {
  it("ignores Esc while a setMembers call is in flight", async () => {
    const setMembers = vi.fn<
      Parameters<PanelAuthoringDataSource["setMembers"]>,
      ReturnType<PanelAuthoringDataSource["setMembers"]>
    >(() => new Promise<void>(() => undefined));
    const value = {
      panels: {
        loadList: async () => [],
        loadDetail: async () => detail,
      },
      experts: {
        loadList: async () => experts,
        loadDetail: async () => undefined,
      },
      panelAuthoring: createAuthoring(setMembers),
    } as TuiDataSources;

    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels/strategy", "/panels/strategy/members"]}>
            <Routes>
              <Route path="/panels/strategy" element={<Text>PANEL DETAIL</Text>} />
              <Route
                path="/panels/:name/members"
                element={<PanelMembersScreen theme={theme} isActive />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(setMembers).toHaveBeenCalledTimes(1);

    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).not.toContain("PANEL DETAIL");
    expect(lastFrame()).toContain("Members:");
    unmount();
  });

  it("ignores a second submit while a save is in flight (single setMembers call)", async () => {
    const setMembers = vi.fn<Parameters<PanelAuthoringDataSource["setMembers"]>, Promise<void>>(
      () => new Promise<void>(() => undefined),
    );
    const { stdin, unmount } = renderScreen({ panelAuthoring: createAuthoring(setMembers) });

    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\r");
    await flush();

    expect(setMembers).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("renders a sanitized error when loading the panel members fails", async () => {
    const { lastFrame, unmount } = renderScreen({
      loadDetail: async () => {
        throw new Error("db down\u001B[31m");
      },
    });

    await flush();

    expect(lastFrame()).toContain("Failed to load panel members");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });
});

import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ExpertListItem } from "../../../src/tui/adapters/experts-data.js";
import type { PanelAuthoringDataSource } from "../../../src/tui/adapters/panel-authoring.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { PanelCreateScreen } from "../../../src/tui/screens/PanelCreateScreen.js";
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
    panelCount: 0,
  },
  {
    slug: "cfo",
    displayName: "Chief Financial Officer",
    role: "Finance",
    kind: "persona",
    panelCount: 1,
  },
];

function PanelProbe(): React.ReactElement {
  const params = useParams();
  return <Text>DETAIL {params.name}</Text>;
}

function createAuthoring(
  create: PanelAuthoringDataSource["create"] = async () => undefined,
): PanelAuthoringDataSource {
  return {
    create,
    setMembers: async () => undefined,
    countRetainedDebates: async () => 0,
    delete: async () => undefined,
  };
}

function renderScreen(
  options: {
    readonly loadList?: () => Promise<readonly ExpertListItem[]>;
    readonly panelAuthoring?: PanelAuthoringDataSource;
  } = {},
): ReturnType<typeof render> {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    experts: {
      loadList: options.loadList ?? (async () => experts),
      loadDetail: async () => undefined,
    },
    panelAuthoring: options.panelAuthoring ?? createAuthoring(),
  } as TuiDataSources;

  return render(
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/panels/new"]}>
          <Routes>
            <Route path="/panels/new" element={<PanelCreateScreen theme={theme} isActive />} />
            <Route path="/panels/:name" element={<PanelProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

describe("PanelCreateScreen", () => {
  it("renders the name field and sanitized expert multi-select", async () => {
    const { lastFrame, unmount } = renderScreen();

    await flush();

    expect(lastFrame()).toContain("Name:");
    expect(lastFrame()).toContain("[ ] Chief Technology Officer — Technology strategy [generic]");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("creates a panel from a typed name and selected expert, then navigates to the detail route", async () => {
    const create = vi.fn<
      Parameters<PanelAuthoringDataSource["create"]>,
      ReturnType<PanelAuthoringDataSource["create"]>
    >(async () => undefined);
    const { stdin, lastFrame, unmount } = renderScreen({ panelAuthoring: createAuthoring(create) });
    await flush();

    stdin.write("strategy-panel");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(" ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(create).toHaveBeenCalledWith({
      name: "strategy-panel",
      description: null,
      expertSlugs: ["cto"],
    });
    expect(lastFrame()).toContain("DETAIL strategy-panel");
    unmount();
  });

  it("shows a sanitized inline validation error for an invalid name and does not create", async () => {
    const create = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderScreen({ panelAuthoring: createAuthoring(create) });
    await flush();

    stdin.write("Bad Name");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(" ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(create).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Invalid panel name");
    expect(lastFrame()).not.toContain("\n\u001B[31m");
    unmount();
  });

  it("shows an inline error for an empty expert selection and does not create", async () => {
    const create = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderScreen({ panelAuthoring: createAuthoring(create) });
    await flush();

    stdin.write("strategy-panel");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write("\r");
    await flush();

    expect(create).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Select at least one expert");
    unmount();
  });

  it("shows a sanitized inline error when create rejects", async () => {
    const create = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(
      async () => {
        throw new Error("Nope\n\u001B[31mtry again");
      },
    );
    const { stdin, lastFrame, unmount } = renderScreen({ panelAuthoring: createAuthoring(create) });
    await flush();

    stdin.write("strategy-panel");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(" ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Nope try again");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("does not create while the expert list is still loading", async () => {
    const create = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderScreen({
      loadList: async () => new Promise<readonly ExpertListItem[]>(() => undefined),
      panelAuthoring: createAuthoring(create),
    });
    await flush();

    stdin.write("strategy-panel");
    await flush();
    stdin.write("\r");
    await flush();

    expect(create).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Loading experts");
    unmount();
  });

  it("guards against double-submit while create is in flight", async () => {
    const create = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(
      async () => new Promise<void>(() => undefined),
    );
    const { stdin, unmount } = renderScreen({ panelAuthoring: createAuthoring(create) });
    await flush();

    stdin.write("strategy-panel");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(" ");
    await flush();
    stdin.write("\r");
    stdin.write("\r");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("PanelCreateScreen — cancel", () => {
  it("navigates back to the previous screen on Esc", async () => {
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      experts: {
        loadList: async () => experts,
        loadDetail: async () => undefined,
      },
      panelAuthoring: createAuthoring(),
    } as TuiDataSources;

    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels", "/panels/new"]}>
            <Routes>
              <Route path="/panels" element={<Text>PANELS LIST</Text>} />
              <Route path="/panels/new" element={<PanelCreateScreen theme={theme} isActive />} />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    expect(lastFrame()).toContain("Name:");

    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).toContain("PANELS LIST");
    unmount();
  });
});

describe("PanelCreateScreen — no experts", () => {
  it("shows a no-experts warning when the experts list is empty", async () => {
    const { lastFrame, unmount } = renderScreen({
      loadList: async () => [],
    });

    await flush();

    expect(lastFrame()).toContain("No experts yet");
    unmount();
  });

  it("does not render the empty MultiSelectList silently when there are no experts", async () => {
    const { lastFrame, unmount } = renderScreen({
      loadList: async () => [],
    });

    await flush();

    // Should show the warning, not silently show an empty member list
    expect(lastFrame()).toContain("No experts yet");
    expect(lastFrame()).toContain("create an expert");
    unmount();
  });

  it("renders the member multi-select (not the warning) when there are experts", async () => {
    const { lastFrame, unmount } = renderScreen();

    await flush();

    expect(lastFrame()).not.toContain("No experts yet");
    expect(lastFrame()).toContain("[ ] Chief Technology Officer");
    unmount();
  });

  it("Tab keeps focus on name when there are no experts", async () => {
    const { stdin, lastFrame, unmount } = renderScreen({ loadList: async () => [] });
    await flush();

    // Type into name field, then press Tab — focus must not leak to the absent members control
    stdin.write("abc");
    await flush();
    stdin.write("\t");
    await flush();
    // If Tab leaked focus to members, subsequent chars won't reach the name TextInput
    stdin.write("d");
    await flush();

    expect(lastFrame()).toContain("abcd");
    expect(lastFrame()).toContain("No experts yet");
    unmount();
  });
});

describe("PanelCreateScreen — cancel during in-flight create", () => {
  it("ignores Esc while a create is in flight (does not navigate back)", async () => {
    const create = vi.fn<
      Parameters<PanelAuthoringDataSource["create"]>,
      ReturnType<PanelAuthoringDataSource["create"]>
    >(() => new Promise<void>(() => undefined));
    const value = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
      experts: {
        loadList: async () => experts,
        loadDetail: async () => undefined,
      },
      panelAuthoring: createAuthoring(create),
    } as TuiDataSources;

    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={value}>
          <MemoryRouter initialEntries={["/panels", "/panels/new"]}>
            <Routes>
              <Route path="/panels" element={<Text>PANELS LIST</Text>} />
              <Route path="/panels/new" element={<PanelCreateScreen theme={theme} isActive />} />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("p1");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write(" ");
    await flush();
    stdin.write("\r");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);

    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 140));

    expect(lastFrame()).not.toContain("PANELS LIST");
    expect(lastFrame()).toContain("Members:");
    unmount();
  });
});

import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { PanelAuthoringDataSource } from "../../../src/tui/adapters/panel-authoring.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { PanelDeleteScreen } from "../../../src/tui/screens/PanelDeleteScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const waitForEscape = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 140));
  await flush();
};

interface RenderDeleteOptions {
  readonly countRetainedDebates?: PanelAuthoringDataSource["countRetainedDebates"];
  readonly deletePanel?: PanelAuthoringDataSource["delete"];
  readonly initialEntries?: readonly string[];
  readonly initialIndex?: number;
}

interface RenderDeleteResult extends ReturnType<typeof render> {
  readonly countRetainedDebates: PanelAuthoringDataSource["countRetainedDebates"];
  readonly deletePanel: PanelAuthoringDataSource["delete"];
}

function createAuthoring(options: RenderDeleteOptions = {}): PanelAuthoringDataSource {
  return {
    create: async () => undefined,
    setMembers: async () => undefined,
    countRetainedDebates:
      options.countRetainedDebates ??
      vi.fn<
        Parameters<PanelAuthoringDataSource["countRetainedDebates"]>,
        ReturnType<PanelAuthoringDataSource["countRetainedDebates"]>
      >(async () => 3),
    delete:
      options.deletePanel ??
      vi.fn<
        Parameters<PanelAuthoringDataSource["delete"]>,
        ReturnType<PanelAuthoringDataSource["delete"]>
      >(async () => undefined),
  };
}

function withAuthoring(panelAuthoring: PanelAuthoringDataSource): TuiDataSources {
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    panelAuthoring,
  };
}

function renderDelete(options: RenderDeleteOptions = {}): RenderDeleteResult {
  const panelAuthoring = createAuthoring(options);
  const result = render(
    <InputCaptureProvider>
      <DataProvider value={withAuthoring(panelAuthoring)}>
        <MemoryRouter
          initialEntries={options.initialEntries ?? ["/panels", "/panels/strategy/delete"]}
          initialIndex={options.initialIndex ?? 1}
        >
          <Routes>
            <Route path="/panels" element={<Text>PANELS LIST</Text>} />
            <Route
              path="/panels/:name/delete"
              element={<PanelDeleteScreen theme={theme} isActive />}
            />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );

  return {
    ...result,
    countRetainedDebates: panelAuthoring.countRetainedDebates,
    deletePanel: panelAuthoring.delete,
  };
}

describe("PanelDeleteScreen", () => {
  it("loads and renders a sanitized retained-session warning with the count", async () => {
    const { lastFrame, countRetainedDebates, unmount } = renderDelete({
      initialEntries: ["/panels/strategy%1B%5B31m/delete"],
      initialIndex: 0,
    });

    await flush();

    expect(countRetainedDebates).toHaveBeenCalledWith("strategy\u001B[31m");
    expect(lastFrame()).toContain('Delete panel "strategy"?');
    expect(lastFrame()).toContain("3 saved session");
    expect(lastFrame()).toContain("Press y to delete, n or Esc to cancel");
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });

  it("deletes on y after the retained-session warning has loaded and navigates to panels", async () => {
    const deletePanel = vi.fn<
      Parameters<PanelAuthoringDataSource["delete"]>,
      ReturnType<PanelAuthoringDataSource["delete"]>
    >(async () => undefined);
    const { stdin, lastFrame, unmount } = renderDelete({ deletePanel });

    await flush();
    stdin.write("y");
    await flush();

    expect(deletePanel).toHaveBeenCalledTimes(1);
    expect(deletePanel).toHaveBeenCalledWith("strategy");
    expect(lastFrame()).toContain("PANELS LIST");
    unmount();
  });

  it("does not delete on y while the retained-session warning is still loading", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderDelete({
      countRetainedDebates: async () => new Promise<number>(() => undefined),
      deletePanel,
    });

    await flush();
    expect(lastFrame()).toContain("Loading");
    stdin.write("y");
    await flush();

    expect(deletePanel).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Loading");
    unmount();
  });

  it("guards against double-y while delete is in flight", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>(
      async () => new Promise<void>(() => undefined),
    );
    const { stdin, unmount } = renderDelete({ deletePanel });

    await flush();
    stdin.write("y");
    stdin.write("y");
    await flush();

    expect(deletePanel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("cancels on n without deleting", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderDelete({ deletePanel });

    await flush();
    stdin.write("n");
    await flush();

    expect(deletePanel).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("PANELS LIST");
    unmount();
  });

  it("navigates back on Esc while idle", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderDelete({ deletePanel });

    await flush();
    stdin.write("\u001B");
    await waitForEscape();

    expect(deletePanel).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("PANELS LIST");
    unmount();
  });

  it("does not navigate back on Esc while delete is in flight", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>(
      async () => new Promise<void>(() => undefined),
    );
    const { stdin, lastFrame, unmount } = renderDelete({ deletePanel });

    await flush();
    stdin.write("y");
    await flush();
    expect(deletePanel).toHaveBeenCalledTimes(1);

    stdin.write("\u001B");
    await waitForEscape();

    expect(lastFrame()).not.toContain("PANELS LIST");
    expect(lastFrame()).toContain('Delete panel "strategy"?');
    unmount();
  });

  it("shows a sanitized load error and does not delete", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>();
    const { stdin, lastFrame, unmount } = renderDelete({
      countRetainedDebates: async () => {
        throw new Error("boom\n\u001B[31mretry");
      },
      deletePanel,
    });

    await flush();
    expect(lastFrame()).toContain("Failed to load: boom retry");
    expect(lastFrame()).not.toContain("\u001B[31m");

    stdin.write("y");
    await flush();

    expect(deletePanel).not.toHaveBeenCalled();
    unmount();
  });

  it("shows a sanitized delete error and stays on the confirm screen when delete fails", async () => {
    const deletePanel = vi.fn<Parameters<PanelAuthoringDataSource["delete"]>, Promise<void>>(
      async () => {
        throw new Error("nope\n\u001B[31mtry again");
      },
    );
    const { stdin, lastFrame, unmount } = renderDelete({ deletePanel });

    await flush();
    stdin.write("y");
    await flush();

    expect(deletePanel).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("nope try again");
    expect(lastFrame()).toContain('Delete panel "strategy"?');
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });
});

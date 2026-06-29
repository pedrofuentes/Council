import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type {
  BuildResult,
  ExpertAuthoringSource,
  ExpertFormValues,
} from "../../../src/tui/adapters/expert-authoring.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ExpertDeleteScreen } from "../../../src/tui/screens/ExpertDeleteScreen.js";
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
  readonly affectedPanels?: readonly string[];
  readonly initialEntries?: readonly string[];
  readonly initialIndex?: number;
  readonly remove?: ExpertAuthoringSource["remove"];
}

interface RenderDeleteResult extends ReturnType<typeof render> {
  readonly remove: ExpertAuthoringSource["remove"];
}

const okResult: BuildResult = {
  ok: true,
  definition: {
    slug: "unused",
    displayName: "Unused",
    role: "Unused",
    expertise: { weightedEvidence: [], referenceCases: [], notExpertIn: [] },
    epistemicStance: "Unused",
    kind: "generic",
  },
};

const emptyForm: ExpertFormValues = {
  slug: "",
  displayName: "",
  role: "",
  weightedEvidence: "",
  referenceCases: "",
  notExpertIn: "",
  epistemicStance: "",
  kind: "generic",
  personaDescription: "",
  model: "",
};

function sourceFor(options: RenderDeleteOptions): {
  readonly source: ExpertAuthoringSource;
  readonly remove: ExpertAuthoringSource["remove"];
} {
  const panels = options.affectedPanels ?? ["board", "exec"];
  const remove =
    options.remove ??
    (vi.fn(async () => ({ affectedPanels: panels })) satisfies ExpertAuthoringSource["remove"]);

  return {
    remove,
    source: {
      loadForEdit: async () => emptyForm,
      create: async () => okResult,
      update: async () => okResult,
      remove,
      affectedPanels: async () => panels,
    },
  };
}

function withAuthoring(source: ExpertAuthoringSource): TuiDataSources {
  return {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    expertAuthoring: source,
  };
}

function renderDelete(options: RenderDeleteOptions = {}): RenderDeleteResult {
  const { source, remove } = sourceFor(options);
  const result = render(
    <InputCaptureProvider>
      <DataProvider value={withAuthoring(source)}>
        <MemoryRouter
          initialEntries={options.initialEntries ?? ["/experts", "/experts/cto/delete"]}
          initialIndex={options.initialIndex ?? 1}
        >
          <Routes>
            <Route path="/experts" element={<Text>LIST</Text>} />
            <Route path="/prior" element={<Text>PRIOR</Text>} />
            <Route path="/experts/:slug/delete" element={<ExpertDeleteScreen theme={theme} />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );

  return { ...result, remove };
}

describe("ExpertDeleteScreen", () => {
  it("shows the sanitized slug and affected panels", async () => {
    const { lastFrame, unmount } = renderDelete({
      initialEntries: ["/experts/cto%0Aevil/delete"],
      initialIndex: 0,
      affectedPanels: ["board\nops", "exec\u001B[31m"],
    });

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain('Delete expert "cto evil"?');
    expect(frame).toContain("Used in 2 panel(s): board ops, exec");
    expect(frame).toContain("Press y to delete, n or Esc to cancel");
    expect(frame).not.toContain("\u001B[31m");
    unmount();
  });

  it("does not delete while the affected-panel warning is still loading", async () => {
    const remove = vi.fn(async () => ({ affectedPanels: [] as readonly string[] }));
    const source: ExpertAuthoringSource = {
      loadForEdit: async () => emptyForm,
      create: async () => okResult,
      update: async () => okResult,
      remove,
      affectedPanels: () =>
        new Promise<readonly string[]>(() => {
          /* never resolves — keeps the screen in the loading state */
        }),
    };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={withAuthoring(source)}>
          <MemoryRouter initialEntries={["/experts", "/experts/cto/delete"]} initialIndex={1}>
            <Routes>
              <Route path="/experts" element={<Text>LIST</Text>} />
              <Route path="/experts/:slug/delete" element={<ExpertDeleteScreen theme={theme} />} />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    expect(lastFrame() ?? "").toContain("Loading");
    stdin.write("y");
    await flush();
    expect(remove).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").toContain("Loading");
    unmount();
  });

  it("shows an error and does not delete when the affected-panel load fails", async () => {
    const remove = vi.fn(async () => ({ affectedPanels: [] as readonly string[] }));
    const source: ExpertAuthoringSource = {
      loadForEdit: async () => emptyForm,
      create: async () => okResult,
      update: async () => okResult,
      remove,
      affectedPanels: async () => {
        throw new Error("boom");
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={withAuthoring(source)}>
          <MemoryRouter initialEntries={["/experts", "/experts/cto/delete"]} initialIndex={1}>
            <Routes>
              <Route path="/experts" element={<Text>LIST</Text>} />
              <Route path="/experts/:slug/delete" element={<ExpertDeleteScreen theme={theme} />} />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    expect(lastFrame() ?? "").toMatch(/Failed to load/i);
    stdin.write("y");
    await flush();
    expect(remove).not.toHaveBeenCalled();
    unmount();
  });

  it("deletes once on y and navigates to the experts list", async () => {
    const { stdin, lastFrame, remove, unmount } = renderDelete();

    await flush();
    stdin.write("y");
    stdin.write("y");
    await flush();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("cto");
    expect(lastFrame()).toContain("LIST");
    unmount();
  });

  it("shows when the expert is not used in any panels", async () => {
    const { lastFrame, unmount } = renderDelete({ affectedPanels: [] });

    await flush();

    expect(lastFrame()).toContain("Not used in any panels.");
    unmount();
  });

  it("cancels on n without removing the expert", async () => {
    const { stdin, lastFrame, remove, unmount } = renderDelete();

    await flush();
    stdin.write("n");
    await flush();

    expect(remove).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("LIST");
    unmount();
  });

  it("cancels on Esc without removing the expert", async () => {
    const { stdin, lastFrame, remove, unmount } = renderDelete();

    await flush();
    stdin.write("\u001B");
    await waitForEscape();

    expect(remove).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("LIST");
    unmount();
  });

  it("shows an error and stays on the confirm screen when authoring is unavailable", async () => {
    const sources: TuiDataSources = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
    };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={sources}>
          <MemoryRouter initialEntries={["/experts", "/experts/cto/delete"]} initialIndex={1}>
            <Routes>
              <Route path="/experts" element={<Text>LIST</Text>} />
              <Route path="/experts/:slug/delete" element={<ExpertDeleteScreen theme={theme} />} />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("y");
    await flush();

    expect(lastFrame()).not.toContain("LIST");
    expect(lastFrame()).toContain('Delete expert "cto"?');
    expect(lastFrame() ?? "").toMatch(/unavailable/i);
    unmount();
  });

  it("shows a sanitized error and stays on the confirm screen when delete fails", async () => {
    const remove = vi.fn(async () => {
      throw new Error("nope\nbad\u001B[31m");
    });
    const { stdin, lastFrame, unmount } = renderDelete({ remove });

    await flush();
    stdin.write("y");
    await flush();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("nope bad");
    expect(lastFrame()).toContain('Delete expert "cto"?');
    expect(lastFrame()).not.toContain("\u001B[31m");
    unmount();
  });
});

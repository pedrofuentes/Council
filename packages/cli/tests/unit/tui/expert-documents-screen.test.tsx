import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type {
  ExpertDocumentsDataSource,
  ExpertDocumentView,
} from "../../../src/tui/adapters/expert-documents.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { ExpertDocumentsScreen } from "../../../src/tui/screens/ExpertDocumentsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const docFor = (overrides: Partial<ExpertDocumentView>): ExpertDocumentView => ({
  id: "doc-1",
  filename: "roadmap.md",
  sizeBytes: 42,
  wordCount: 7,
  status: "processed",
  processedAt: "2026-06-23T00:00:00.000Z",
  ...overrides,
});

const withDocuments = (documents: ExpertDocumentsDataSource): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  documents,
});

function renderScreen(documents: ExpertDocumentsDataSource): ReturnType<typeof render> {
  return render(
    <DataProvider value={withDocuments(documents)}>
      <MemoryRouter initialEntries={["/experts/cto/docs"]}>
        <Routes>
          <Route
            path="/experts/:slug/docs"
            element={<ExpertDocumentsScreen theme={theme} isActive />}
          />
        </Routes>
      </MemoryRouter>
    </DataProvider>,
  );
}

describe("ExpertDocumentsScreen", () => {
  it("renders the loading state", () => {
    const documents: ExpertDocumentsDataSource = {
      list: () => new Promise<readonly ExpertDocumentView[]>(() => undefined),
      remove: async () => ({ ftsCleanupFailed: false }),
    };

    const { lastFrame, unmount } = renderScreen(documents);

    expect(lastFrame()).toContain("Loading documents…");
    unmount();
  });

  it("renders the error state", async () => {
    const documents: ExpertDocumentsDataSource = {
      list: async () => {
        throw new Error("boom");
      },
      remove: async () => ({ ftsCleanupFailed: false }),
    };

    const { lastFrame, unmount } = renderScreen(documents);
    await flush();

    expect(lastFrame()).toContain("Failed to load documents");
    unmount();
  });

  it("renders the empty state", async () => {
    const documents: ExpertDocumentsDataSource = {
      list: async () => [],
      remove: async () => ({ ftsCleanupFailed: false }),
    };

    const { lastFrame, unmount } = renderScreen(documents);
    await flush();

    expect(lastFrame()).toContain("No indexed documents for this persona.");
    unmount();
  });

  it("renders loaded document rows", async () => {
    const documents: ExpertDocumentsDataSource = {
      list: async () => [
        docFor({ filename: "roadmap.md" }),
        docFor({ id: "doc-2", filename: "brief.md" }),
      ],
      remove: async () => ({ ftsCleanupFailed: false }),
    };

    const { lastFrame, unmount } = renderScreen(documents);
    await flush();

    expect(lastFrame()).toContain("roadmap.md");
    expect(lastFrame()).toContain("brief.md");
    unmount();
  });

  it("confirms removal with Enter and y, calls remove, then reloads the list", async () => {
    const remove = vi.fn(async () => ({ ftsCleanupFailed: false }));
    const list = vi
      .fn<ExpertDocumentsDataSource["list"]>()
      .mockResolvedValueOnce([
        docFor({ id: "doc-1", filename: "roadmap.md" }),
        docFor({ id: "doc-2", filename: "brief.md" }),
      ])
      .mockResolvedValueOnce([docFor({ id: "doc-2", filename: "brief.md" })]);
    const { stdin, lastFrame, unmount } = renderScreen({ list, remove });

    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain('Remove "roadmap.md"? [y/n]');

    stdin.write("y");
    await flush();

    expect(remove).toHaveBeenCalledWith("cto", "doc-1");
    expect(list).toHaveBeenCalledTimes(2);
    expect(lastFrame()).not.toContain("roadmap.md");
    expect(lastFrame()).toContain("brief.md");
    unmount();
  });

  it("dismisses the confirm prompt with n without removing", async () => {
    const remove = vi.fn(async () => ({ ftsCleanupFailed: false }));
    const documents: ExpertDocumentsDataSource = {
      list: async () => [docFor({ id: "doc-1", filename: "roadmap.md" })],
      remove,
    };
    const { stdin, lastFrame, unmount } = renderScreen(documents);

    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain('Remove "roadmap.md"? [y/n]');

    stdin.write("n");
    await flush();

    expect(remove).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('Remove "roadmap.md"? [y/n]');
    expect(lastFrame()).toContain("roadmap.md");
    unmount();
  });

  it("does not remove when y is pressed while the list is still loading", async () => {
    const remove = vi.fn(async () => ({ ftsCleanupFailed: false }));
    const documents: ExpertDocumentsDataSource = {
      list: () => new Promise<readonly ExpertDocumentView[]>(() => undefined),
      remove,
    };
    const { stdin, lastFrame, unmount } = renderScreen(documents);

    await flush();
    stdin.write("\r");
    stdin.write("y");
    await flush();

    expect(remove).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Loading documents…");
    unmount();
  });
});

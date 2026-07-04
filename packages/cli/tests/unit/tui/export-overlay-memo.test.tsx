import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExportViewSource } from "../../../src/tui/adapters/export-view.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ExportOverlay } from "../../../src/tui/screens/ExportOverlay.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

// Capture the `items` array ExportOverlay hands to ScrollView on every render.
// The rendered frame is identical whether or not the rows are memoized, so the
// only observable signal of the #1695 fix is the *referential identity* of that
// array across re-renders that leave the preview content unchanged.
const { capturedItems } = vi.hoisted(() => ({
  capturedItems: [] as (readonly string[])[],
}));

vi.mock("../../../src/tui/components/lists/ScrollView.js", () => ({
  ScrollView: (props: { readonly items: readonly string[]; readonly height: number }): null => {
    capturedItems.push(props.items);
    return null;
  },
}));

const theme = resolveTheme({ NO_COLOR: "1" });
const ENTER = "\r";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
};

function buildTree(source: ExportViewSource): React.ReactElement {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    export: source,
  } as TuiDataSources;

  return (
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter
          initialEntries={[{ pathname: "/sessions/p1/export", state: { panelName: "Acme" } }]}
          initialIndex={0}
        >
          <Routes>
            <Route path="/sessions/:id/export" element={<ExportOverlay theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>
  );
}

describe("ExportOverlay preview-row memoization (#1695)", () => {
  beforeEach(() => {
    capturedItems.length = 0;
  });

  it("reuses the same preview-rows array across a re-render with unchanged content", async () => {
    // The preview→saved transition re-renders with byte-identical content, so a
    // memoized derivation must yield the *same* array reference; an unmemoized
    // `previewRows(phase.content)` on every render would produce a fresh one.
    const source: ExportViewSource = {
      render: async () => "row-a\nrow-b\nrow-c",
      writeFile: vi.fn(async () => undefined),
    };

    const { stdin } = render(buildTree(source));

    await flush();
    stdin.write(ENTER); // pick markdown → render → preview
    await flush();

    const beforeRows = capturedItems.at(-1);
    const countAfterPreview = capturedItems.length;
    expect(beforeRows, "expected a preview render before writing").toBeDefined();
    expect(beforeRows).toEqual(["row-a", "row-b", "row-c"]);

    stdin.write(ENTER); // write file → phase becomes "saved" (content unchanged)
    await flush();

    // The saved phase actually re-rendered the preview (new ScrollView render)…
    expect(capturedItems.length).toBeGreaterThan(countAfterPreview);
    // …but the derived rows array is referentially stable, proving it is memoized
    // on the content rather than recomputed on every render.
    expect(capturedItems.at(-1)).toBe(beforeRows);
  });
});

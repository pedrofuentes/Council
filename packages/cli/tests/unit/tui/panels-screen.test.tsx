import { EventEmitter } from "node:events";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { describe, expect, it } from "vitest";

import type { PanelListItem } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { PanelsScreen } from "../../../src/tui/screens/PanelsScreen.js";
import { type ResizableStdout } from "../../../src/tui/hooks/use-terminal-size.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

class FakeStdout extends EventEmitter implements ResizableStdout {
  public columns: number | undefined;
  public rows: number | undefined;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
}

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};
const withPanels = (loadList: () => Promise<readonly PanelListItem[]>): TuiDataSources => ({
  panels: { loadList, loadDetail: async () => undefined },
});

/**
 * Splits a rendered frame into its terminal rows. ListViewport's bordered
 * preview pane is laid out beside the list pane in a row-flex Box (see
 * ListViewport.tsx), so both isolating the pane's own text and verifying a
 * hint sits on the same row as its panel require row-level granularity —
 * a frame-wide substring search can't distinguish "in this pane/row" from
 * "somewhere in the frame".
 */
function frameRows(frame: string | undefined): readonly string[] {
  return (frame ?? "").split("\n");
}

// The bordered preview pane (`borderStyle="single"` in ListViewport) is
// rendered to the right of the list pane on every terminal row; its left
// edge is always one of these box-drawing characters. Slicing each row from
// the first match isolates the preview pane's own text and discards
// whatever the list pane drew to its left on that same row.
const PREVIEW_PANE_LEFT_EDGE = /[┌│└]/;

/** Isolates the bordered preview-pane region of a rendered frame. */
function previewPaneText(frame: string | undefined): string {
  return frameRows(frame)
    .map((row) => {
      const edgeIndex = row.search(PREVIEW_PANE_LEFT_EDGE);
      return edgeIndex === -1 ? "" : row.slice(edgeIndex);
    })
    .join("\n");
}

/** Asserts some single row of `frame` contains every one of `needles` (row-level co-occurrence). */
function expectRowWithAll(frame: string | undefined, ...needles: readonly string[]): void {
  const rows = frameRows(frame);
  const found = rows.some((row) => needles.every((needle) => row.includes(needle)));
  expect(found, `expected a single row containing all of: ${needles.join(", ")}`).toBe(true);
}

function DetailProbe(): React.ReactElement {
  const params = useParams();
  return <Text>DETAIL {params.name}</Text>;
}

describe("PanelsScreen", () => {
  it("renders loaded panels", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme\u001B[31m", description: "Exec\nPanel", memberCount: 2, source: "saved" },
          { name: "startup-board", description: "tpl", memberCount: 3, source: "template" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toContain("acme");
    expect(lastFrame()).not.toContain("Exec Panel"); // description dropped from list row
    // Row-level co-occurrence: each hint must land on the SAME row as its own
    // panel, not merely appear somewhere in the frame — a regression that
    // mis-associates counts with panels (e.g. swapped rows) must fail (#1763).
    expectRowWithAll(lastFrame(), "acme", "2 experts");
    expectRowWithAll(lastFrame(), "startup-board", "3 experts");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("shows an empty state with next-step teacher text", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}>
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/No panels/i);
    expect(lastFrame()).toContain("[c] auto-compose from a topic, or [n] build from experts");
  });

  it("shows an error state", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => {
          throw new Error("x");
        })}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/Failed to load panels/i);
  });

  it("navigates to the selected panel detail on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme", description: "Exec panel", memberCount: 1, source: "saved" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/:name" element={<DetailProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("DETAIL acme");
  });

  it("navigates to panel creation with n in the non-empty state", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme", description: "Exec panel", memberCount: 1, source: "saved" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("n");
    await flush();

    expect(lastFrame()).toContain("NEW PANEL");
  });

  it("navigates to panel creation with n in the empty state", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}>
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("n");
    await flush();

    expect(lastFrame()).toContain("NEW PANEL");
  });

  it("navigates to panel auto-compose with c in the non-empty state", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme", description: "Exec panel", memberCount: 1, source: "saved" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("c");
    await flush();

    expect(lastFrame()).toContain("COMPOSE PANEL");
  });

  it("navigates to panel auto-compose with c in the empty state", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}>
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("c");
    await flush();

    expect(lastFrame()).toContain("COMPOSE PANEL");
  });

  it("renders the ListViewport count header (position/total)", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "alpha", description: "", memberCount: 1, source: "saved" },
          { name: "beta", description: "", memberCount: 2, source: "template" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    // ListViewport header must contain "1/2" (cursor=1, total=2)
    expect(lastFrame()).toMatch(/1\/2/);
  });

  it("list row shows panel name and expert count but not description", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          {
            name: "advisory-board",
            description: "Finance strategy",
            memberCount: 4,
            source: "saved",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("advisory-board");
    expect(frame).toContain("4 experts");
    expect(frame).not.toContain("Finance strategy"); // description dropped from list row
  });

  it("description still appears in preview pane at wide widths", async () => {
    const wideStdout = new FakeStdout(140, 24);
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          {
            name: "advisory-board",
            description: "Finance strategy",
            memberCount: 4,
            source: "saved",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive stdout={wideStdout} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    // Bound to the bordered preview pane region (not the whole frame) so a
    // regression that reintroduces the description into the list row instead
    // of the pane fails this assertion (#1762).
    expect(previewPaneText(lastFrame())).toContain("Finance strategy");
  });

  it("resolves selection to the correct panel when names duplicate across sources", async () => {
    function DetailSourceProbe(): React.ReactElement {
      const params = useParams();
      const location = useLocation();
      const src = (location.state as { readonly source?: string } | null)?.source ?? "none";
      return (
        <Text>
          DETAIL {params.name} source={src}
        </Text>
      );
    }

    const { stdin, lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme", description: "Saved panel", memberCount: 1, source: "saved" },
          { name: "acme", description: "Template panel", memberCount: 2, source: "template" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <Routes>
            <Route path="/panels" element={<PanelsScreen theme={theme} isActive />} />
            <Route path="/panels/:name" element={<DetailSourceProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("j"); // move cursor to second item (template "acme")
    await flush();
    stdin.write("\r"); // select
    await flush();

    expect(lastFrame()).toContain("DETAIL acme");
    expect(lastFrame()).toContain("source=template");
  });

  it("shows a panel preview summary beside the list at wide widths", async () => {
    const wideStdout = new FakeStdout(140, 24);
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          // Embed a raw ANSI sequence in the name so we can assert sanitization
          { name: "alpha\u001B[31m-panel", description: "", memberCount: 3, source: "saved" },
          { name: "beta-panel", description: "Strategy group", memberCount: 1, source: "template" },
        ])}
      >
        <MemoryRouter initialEntries={["/panels"]}>
          <PanelsScreen theme={theme} isActive stdout={wideStdout} />
        </MemoryRouter>
      </DataProvider>,
    );
    await flush();
    // Preview pane must show member count with "members" (distinct from "experts" in list label)
    expect(lastFrame()).toContain("members");
    // Raw ANSI escape from untrusted panel name must not bleed into the preview
    expect(lastFrame()).not.toContain("\u001B[31m");
  });
});

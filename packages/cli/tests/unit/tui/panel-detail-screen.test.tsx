import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import type { PanelDetailView } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { PanelDetailScreen } from "../../../src/tui/screens/PanelDetailScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const withDetail = (
  loadDetail: (name: string, source: "saved" | "template") => Promise<PanelDetailView | undefined>,
): TuiDataSources => ({
  panels: {
    loadList: async () => [],
    loadDetail,
  },
});

describe("PanelDetailScreen", () => {
  it("renders members, defaults, and missing slugs", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme\u001B[31m",
          description: "Exec\nPanel",
          source: "saved",
          defaults: { mode: "structured", maxRounds: 3, model: "gpt\u001B[32m" },
          members: [
            {
              slug: "cto",
              displayName: "Chief\u001B[31m Tech",
              role: "Technology\nStrategy",
              kind: "generic",
            },
          ],
          missing: ["ghost\u001B[33m"],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("Chief Tech");
    expect(lastFrame()).toContain("Technology Strategy");
    expect(lastFrame()).toContain("ghost");
    expect(lastFrame()).toContain("structured");
    expect(lastFrame()).toContain("3 rounds");
    expect(lastFrame()).toContain("gpt");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("renders a not found state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withDetail(async () => undefined)}>
        <MemoryRouter
          initialEntries={[{ pathname: "/panels/missing", state: { source: "saved" } }]}
        >
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/not found/i);
  });

  it("navigates to the members editor when m is pressed on a saved panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/panels/:name/members" element={<Text>EDIT MEMBERS</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    expect(lastFrame()).toContain("m edit members");

    stdin.write("m");
    await flush();

    expect(lastFrame()).toContain("EDIT MEMBERS");
  });

  it("does not navigate to the members editor when m is pressed on a template panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "starter",
          description: "",
          source: "template",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter
          initialEntries={[{ pathname: "/panels/starter", state: { source: "template" } }]}
        >
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/panels/:name/members" element={<Text>EDIT MEMBERS</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    expect(lastFrame()).not.toContain("m edit members");

    stdin.write("m");
    await flush();

    expect(lastFrame()).not.toContain("EDIT MEMBERS");
    expect(lastFrame()).toContain("starter");
  });

  it("navigates to the delete confirm screen when d is pressed on a saved panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/panels/:name/delete" element={<Text>DELETE PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    expect(lastFrame()).toContain("d delete");

    stdin.write("d");
    await flush();

    expect(lastFrame()).toContain("DELETE PANEL");
  });

  it("does not navigate to the delete confirm screen when d is pressed on a template panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "starter",
          description: "",
          source: "template",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter
          initialEntries={[{ pathname: "/panels/starter", state: { source: "template" } }]}
        >
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/panels/:name/delete" element={<Text>DELETE PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    expect(lastFrame()).not.toContain("d delete");

    stdin.write("d");
    await flush();

    expect(lastFrame()).not.toContain("DELETE PANEL");
    expect(lastFrame()).toContain("starter");
  });

  it("navigates to the convene prompt with v on a saved panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/convene/:panel" element={<Text>CONVENE PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    expect(lastFrame()).toContain("v convene");

    stdin.write("v");
    await flush();

    expect(lastFrame()).toContain("CONVENE PANEL");
  });

  it("does not navigate to convene with v on a template panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "starter",
          description: "",
          source: "template",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter
          initialEntries={[{ pathname: "/panels/starter", state: { source: "template" } }]}
        >
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/convene/:panel" element={<Text>CONVENE PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    expect(lastFrame()).not.toContain("v convene");

    stdin.write("v");
    await flush();

    expect(lastFrame()).not.toContain("CONVENE PANEL");
    expect(lastFrame()).toContain("starter");
  });

  it("opens the action menu when a is pressed on a saved panel", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("a");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Actions");
    expect(frame).toContain("Chat");
    expect(frame).toContain("Members");
    expect(frame).toContain("Delete");
    expect(frame).toContain("Convene");
  });

  it("selecting Chat from the action menu navigates the same as pressing c directly", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/chat/panel/:name" element={<Text>CHAT PANEL</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("a"); // open menu
    await flush();
    stdin.write("\r"); // select first item (c Chat)
    await flush();

    expect(lastFrame()).toContain("CHAT PANEL");
  });

  it("selecting Members from the action menu navigates the same as pressing m directly", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
            <Route path="/panels/:name/members" element={<Text>EDIT MEMBERS</Text>} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("a"); // open menu
    await flush();
    stdin.write("j"); // move to second item (m Members)
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("EDIT MEMBERS");
  });

  it("pressing Esc in the action menu closes it", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withDetail(async () => ({
          name: "acme",
          description: "",
          source: "saved",
          members: [],
          missing: [],
        }))}
      >
        <MemoryRouter initialEntries={[{ pathname: "/panels/acme", state: { source: "saved" } }]}>
          <Routes>
            <Route path="/panels/:name" element={<PanelDetailScreen theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("a");
    await flush();
    expect(lastFrame()).toContain("Actions");

    await sleep(20);
    stdin.write("\u001b"); // Esc — Ink buffers a lone Esc for disambiguation
    await sleep(120);

    expect(lastFrame()).not.toContain("Actions");
  });
});

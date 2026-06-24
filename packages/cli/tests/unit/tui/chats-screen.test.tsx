import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it } from "vitest";

import type { ChatListItem } from "../../../src/tui/adapters/chats-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { ChatsScreen } from "../../../src/tui/screens/ChatsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withChats = (list: () => Promise<readonly ChatListItem[]>): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    chats: { list },
  }) as TuiDataSources;

function ExpertProbe(): React.ReactElement {
  const { slug } = useParams();
  return <Text>EXPERT {slug}</Text>;
}

function PanelProbe(): React.ReactElement {
  const { name } = useParams();
  return <Text>PANEL {name}</Text>;
}

describe("ChatsScreen", () => {
  it("renders loaded chats with target glyphs, titles, and timestamps", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withChats(async () => [
          {
            id: "c1",
            targetType: "expert",
            targetSlug: "cto",
            title: "Roadmap\u001B[31m\nreview",
            when: "2h",
            status: "active",
          },
          {
            id: "c2",
            targetType: "panel",
            targetSlug: "growth",
            title: "Growth strategy",
            when: "1d",
            status: "archived",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/chats"]}>
          <ChatsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toContain("👤");
    expect(lastFrame()).toContain("Roadmap review");
    expect(lastFrame()).toContain("2h");
    expect(lastFrame()).toContain("📋");
    expect(lastFrame()).toContain("Growth strategy");
    expect(lastFrame()).toContain("1d");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("shows an empty state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withChats(async () => [])}>
        <MemoryRouter initialEntries={["/chats"]}>
          <ChatsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No chats/i);
  });

  it("shows an error state", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withChats(async () => {
          throw new Error("boom");
        })}
      >
        <MemoryRouter initialEntries={["/chats"]}>
          <ChatsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/Failed to load chats/i);
  });

  it("resumes an expert chat on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withChats(async () => [
          {
            id: "c1",
            targetType: "expert",
            targetSlug: "cto",
            title: "Roadmap review",
            when: "2h",
            status: "active",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/chats"]}>
          <Routes>
            <Route path="/chats" element={<ChatsScreen theme={theme} isActive />} />
            <Route path="/chat/expert/:slug" element={<ExpertProbe />} />
            <Route path="/chat/panel/:name" element={<PanelProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("EXPERT cto");
  });

  it("resumes a panel chat on Enter", async () => {
    const { stdin, lastFrame } = render(
      <DataProvider
        value={withChats(async () => [
          {
            id: "c2",
            targetType: "panel",
            targetSlug: "growth-panel",
            title: "Growth strategy",
            when: "1d",
            status: "active",
          },
        ])}
      >
        <MemoryRouter initialEntries={["/chats"]}>
          <Routes>
            <Route path="/chats" element={<ChatsScreen theme={theme} isActive />} />
            <Route path="/chat/expert/:slug" element={<ExpertProbe />} />
            <Route path="/chat/panel/:name" element={<PanelProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("PANEL growth-panel");
  });

  it("uses an empty list when the chats source is absent", async () => {
    const value: TuiDataSources = {
      panels: { loadList: async () => [], loadDetail: async () => undefined },
    };

    const { lastFrame } = render(
      <DataProvider value={value}>
        <MemoryRouter initialEntries={["/chats"]}>
          <ChatsScreen theme={theme} isActive />
        </MemoryRouter>
      </DataProvider>,
    );

    await flush();

    expect(lastFrame()).toMatch(/No chats/i);
  });
});

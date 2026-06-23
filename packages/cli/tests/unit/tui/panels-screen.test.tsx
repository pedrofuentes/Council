import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { PanelListItem } from "../../../src/tui/adapters/panels-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { PanelsScreen } from "../../../src/tui/screens/PanelsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};
const withPanels = (loadList: () => Promise<readonly PanelListItem[]>): TuiDataSources => ({
  panels: { loadList },
});

describe("PanelsScreen", () => {
  it("renders loaded panels", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => [
          { name: "acme\u001B[31m", description: "Exec\nPanel", memberCount: 2, source: "saved" },
          { name: "startup-board", description: "tpl", memberCount: 3, source: "template" },
        ])}
      >
        <PanelsScreen theme={theme} isActive />
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toContain("acme");
    expect(lastFrame()).toContain("Exec Panel");
    expect(lastFrame()).toContain("startup-board");
    expect(lastFrame()).not.toContain("\u001B[31m");
  });

  it("shows an empty state", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}>
        <PanelsScreen theme={theme} isActive />
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/No panels/i);
  });

  it("shows an error state", async () => {
    const { lastFrame } = render(
      <DataProvider
        value={withPanels(async () => {
          throw new Error("x");
        })}
      >
        <PanelsScreen theme={theme} isActive />
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/Failed to load panels/i);
  });
});

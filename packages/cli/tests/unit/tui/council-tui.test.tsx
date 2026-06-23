import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = {
  counts: { sessions: 3, experts: 2, panels: 1 },
  recent: [{ id: "s1", title: "Build vs buy", when: "2d", status: "convened" }],
};
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe("CouncilTUI", () => {
  it("renders the shell with Home content and nav sections", async () => {
    const { lastFrame, unmount } = render(
      <CouncilTUI homeData={homeData} model="claude-sonnet-4.5" env={{ NO_COLOR: "1" }} initialColumns={140} initialRows={40} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build vs buy"); // Home screen
    expect(frame).toContain("Panels"); // left nav
    expect(frame).toContain("NAV"); // footer mode
    unmount();
  });

  it("opens help with ? and closes it with Esc", async () => {
    const { stdin, lastFrame, unmount } = render(
      <CouncilTUI homeData={homeData} model="m" env={{ NO_COLOR: "1" }} initialColumns={140} initialRows={40} />,
    );
    await flush();
    stdin.write("?");
    await flush();
    expect((lastFrame() ?? "").toLowerCase()).toContain("keyboard shortcuts");
    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);
    expect((lastFrame() ?? "").toLowerCase()).not.toContain("keyboard shortcuts");
    unmount();
  });
});

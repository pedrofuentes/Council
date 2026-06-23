// packages/cli/tests/unit/tui/left-nav.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { LeftNav } from "../../../src/tui/components/navigation/LeftNav.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ FORCE_COLOR: "3" });
const items = [
  { id: "home", label: "Home", glyph: "⌂" },
  { id: "panels", label: "Panels", glyph: "▥" },
  { id: "experts", label: "Experts", glyph: "◆" },
];
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe("LeftNav", () => {
  it("shows labels when expanded and highlights the active item", () => {
    const { lastFrame, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={() => undefined} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Home");
    expect(frame).toContain("Panels");
    expect(frame).toContain("\u001b[7m"); // inverse on the active row
    unmount();
  });

  it("shows only glyphs in rail mode", () => {
    const { lastFrame, unmount } = render(
      <LeftNav items={items} activeId="home" state="rail" onSelect={() => undefined} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⌂");
    expect(frame).not.toContain("Home");
    unmount();
  });

  it("selects the next item with j/down then Enter", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("j"); // -> Panels
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("panels");
    unmount();
  });

  it("moves up with k and wraps, then selects with Enter", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("k"); // wraps from Home(0) to Experts(2)
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("experts");
    unmount();
  });

  it("handles empty items list without crashing", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={[]} activeId="" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("j");
    await flush();
    stdin.write("k");
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBeUndefined(); // no items to select
    unmount();
  });

  it("navigates with arrow keys (down and up)", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("\u001B[B"); // down arrow -> Panels
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("panels");
    unmount();
  });

  it("navigates up with arrow key and wraps", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("\u001B[A"); // up arrow wraps to Experts
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("experts");
    unmount();
  });
});

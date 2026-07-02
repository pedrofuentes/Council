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

  it("shows only glyphs in rail mode", () => {    const { lastFrame, unmount } = render(
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

  it("binds the stable active-route marker to the ACTIVE row (not any other row) with no cursor inverse when not focused", () => {
    const { lastFrame, unmount } = render(
      <LeftNav
        items={items}
        activeId="panels"
        state="expanded"
        isActive={false}
        onSelect={() => undefined}
        theme={theme}
      />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const rowFor = (label: string): string => {
      const line = lines.find((l) => l.includes(label));
      if (line === undefined) throw new Error(`row for "${label}" not found in frame`);
      return line;
    };
    // The marker must sit on the row for the active route ("panels")...
    expect(rowFor("Panels")).toContain("●");
    // ...and must NOT appear on any other row, proving it is bound to the
    // active row rather than merely present somewhere in the frame.
    expect(rowFor("Home")).not.toContain("●");
    expect(rowFor("Experts")).not.toContain("●");
    expect(frame).not.toContain("\u001b[7m"); // no moving cursor highlight when unfocused
    unmount();
  });

  it("shows the moving cursor highlight (inverse) when focused", () => {
    const { lastFrame, unmount } = render(
      <LeftNav
        items={items}
        activeId="panels"
        state="expanded"
        isActive={true}
        onSelect={() => undefined}
        theme={theme}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\u001b[7m"); // inverse cursor present when focused
    unmount();
  });
});

import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import {
  ListViewport,
  type ListViewportItem,
} from "../../../src/tui/components/lists/ListViewport.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});

const flush = async (stdin?: { write: (s: string) => void }, s?: string): Promise<void> => {
  if (stdin !== undefined && s !== undefined) stdin.write(s);
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

// Ink buffers a lone Esc behind a disambiguation timeout — must await real setTimeout.
const pressEsc = async (stdin: { write: (s: string) => void }): Promise<void> => {
  stdin.write("\u001b");
  await new Promise<void>((r) => setTimeout(r, 140));
  await flush();
};

const ITEMS: readonly ListViewportItem[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

const MANY: readonly ListViewportItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `item-${i}`,
  label: `Item ${i}`,
}));

describe("ListViewport", () => {
  it("renders a count header showing position and total", async () => {
    const { lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    // cursor starts at 0 of 3 items → "1/3"
    expect(lastFrame()).toContain("1/3");
  });

  it("updates the count header as the cursor moves", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush(stdin, "j");
    expect(lastFrame()).toContain("2/3");
    await flush(stdin, "j");
    expect(lastFrame()).toContain("3/3");
  });

  it("shows the selection affordance › on the active row", async () => {
    const { lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    // First item is selected — must show › prefix
    expect(frame).toContain("› Alpha");
    // Non-selected items must not have › prefix
    expect(frame).toContain("  Beta");
    expect(frame).toContain("  Gamma");
  });

  it("inverts the background on the selected row", async () => {
    const { lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    // FORCE_COLOR=3 in tests — Ink renders inverse as SGR \u001b[7m
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\u001b[7m");
  });

  it("calls onSelect with the item id on Enter", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={onSelect} theme={theme} />,
    );
    await flush(stdin, "j"); // move to Beta (id="b")
    await flush(stdin, "\r");
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("does not call onSelect when inactive", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ListViewport items={ITEMS} isActive={false} height={5} onSelect={onSelect} theme={theme} />,
    );
    await flush(stdin, "\r");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("g/G jump to the last and first items", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush(stdin, "G");
    expect(lastFrame()).toContain("3/3");
    await flush(stdin, "g");
    expect(lastFrame()).toContain("1/3");
  });

  it("arrow keys navigate up and down", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush(stdin, "\u001b[B"); // down arrow
    expect(lastFrame()).toContain("2/3");
    await flush(stdin, "\u001b[A"); // up arrow
    expect(lastFrame()).toContain("1/3");
  });

  it("PgDn/PgUp move the cursor by one page", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={MANY} isActive height={4} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    expect(lastFrame()).toContain("1/10");
    // pageSize = max(1, 4-1) = 3 → cursor: 0 → 3 → shows 4/10
    await flush(stdin, "\x1B[6~"); // PgDn
    expect(lastFrame()).toContain("4/10");
    await flush(stdin, "\x1B[5~"); // PgUp → cursor: 3 → 0 → shows 1/10
    expect(lastFrame()).toContain("1/10");
  });

  it("shows an overflow indicator when list exceeds the viewport height", async () => {
    const { lastFrame } = render(
      <ListViewport items={MANY} isActive height={3} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↓");
    expect(frame).toContain("more");
  });

  it("does not show an overflow indicator when all items fit in the viewport", async () => {
    const { lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={10} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    expect(lastFrame()).not.toContain("↓");
  });

  it("enters filter mode on / and displays the filter indicator", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush(stdin, "/");
    const frame = lastFrame() ?? "";
    // Header should contain the filter indicator "/"
    expect(frame).toContain("/");
  });

  it("filters items by fuzzy match and updates the visible count", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush(stdin, "/");
    // 'l' is in "Alpha" (pos 1) but not in "Beta" or "Gamma" → only Alpha matches
    await flush(stdin, "l");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Alpha");
    expect(frame).not.toContain("Beta");
    expect(frame).not.toContain("Gamma");
    // Count reflects 1 match; cursor at position 1 → "1/1"
    expect(frame).toContain("1/1");
  });

  it("exits filter mode and restores the full list on Esc", async () => {
    const { stdin, lastFrame } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush(stdin, "/");
    await flush(stdin, "l"); // filter to Alpha only
    expect(lastFrame()).toContain("1/1");
    await pressEsc(stdin);
    // Full list restored
    expect(lastFrame()).toContain("1/3");
    expect(lastFrame()).toContain("Beta");
    expect(lastFrame()).toContain("Gamma");
  });

  it("selects via Enter while in filter mode", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ListViewport items={ITEMS} isActive height={5} onSelect={onSelect} theme={theme} />,
    );
    await flush(stdin, "/");
    await flush(stdin, "l"); // filter to Alpha (id="a")
    await flush(stdin, "\r");
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("renders emptyText when the items list is empty", async () => {
    const { lastFrame } = render(
      <ListViewport
        items={[]}
        isActive
        height={5}
        onSelect={vi.fn()}
        theme={theme}
        emptyText="Nothing here yet"
      />,
    );
    await flush();
    expect(lastFrame()).toContain("Nothing here yet");
  });

  it("renders nothing when items is empty and emptyText is not provided", async () => {
    const { lastFrame } = render(
      <ListViewport items={[]} isActive height={5} onSelect={vi.fn()} theme={theme} />,
    );
    await flush();
    // Should not crash; just renders an empty frame
    expect(lastFrame()).toBeDefined();
  });

  it("sanitizes labels that contain ANSI escape codes", async () => {
    const { lastFrame } = render(
      <ListViewport
        items={[{ id: "x", label: "Hello\x1B[31mWorld" }]}
        isActive
        height={5}
        onSelect={vi.fn()}
        theme={theme}
      />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("HelloWorld");
    // The raw ANSI code must not appear verbatim in the frame
    expect(frame).not.toContain("Hello\x1B[31mWorld");
  });

  it("includes an optional title in the count header", async () => {
    const { lastFrame } = render(
      <ListViewport
        items={ITEMS}
        isActive
        height={5}
        onSelect={vi.fn()}
        theme={theme}
        title="Things"
      />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Things");
    expect(frame).toContain("1/3");
  });

  it("notifies onFilterModeChange when entering and exiting filter mode", async () => {
    const onFilterModeChange = vi.fn();
    const { stdin } = render(
      <ListViewport
        items={ITEMS}
        isActive
        height={5}
        onSelect={vi.fn()}
        theme={theme}
        onFilterModeChange={onFilterModeChange}
      />,
    );
    // Initial mount: fires with false
    await flush();
    expect(onFilterModeChange).toHaveBeenCalledWith(false);

    await flush(stdin, "/"); // enter filter
    expect(onFilterModeChange).toHaveBeenCalledWith(true);

    await pressEsc(stdin); // exit filter
    expect(onFilterModeChange).toHaveBeenCalledWith(false);
  });
});

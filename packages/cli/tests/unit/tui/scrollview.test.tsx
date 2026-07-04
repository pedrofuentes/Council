import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { ScrollView } from "../../../src/tui/components/lists/ScrollView.js";

const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);

describe("ScrollView", () => {
  it("renders only the visible window of items", () => {
    const { lastFrame, unmount } = render(<ScrollView items={items} height={5} cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("item-0");
    expect(frame).toContain("item-4");
    expect(frame).not.toContain("item-5");
    unmount();
  });

  it("pins to the bottom when follow is true", () => {
    const { lastFrame, unmount } = render(<ScrollView items={items} height={5} follow />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("item-49");
    expect(frame).not.toContain("item-0");
    unmount();
  });

  it("shifts the window to keep a below-viewport cursor visible", () => {
    // cursor 7 with viewport 5 => window starts at item-3 (offset = 7 - 5 + 1), shows item-3..item-7
    const { lastFrame, unmount } = render(<ScrollView items={items} height={5} cursor={7} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("item-3");
    expect(frame).toContain("item-7");
    expect(frame).not.toContain("item-2");
    expect(frame).not.toContain("item-8");
    unmount();
  });

  it("highlights only the cursor row with inverse video", () => {
    // Ink renders `inverse` as the SGR reverse-video sequence (ESC[7m); FORCE_COLOR=3 in tests.
    const INVERSE = "\u001b[7m";
    const cursor = 2;
    const highlighted = render(<ScrollView items={items} height={5} cursor={cursor} />);
    const lines = (highlighted.lastFrame() ?? "").split("\n");

    // The inverse SGR must wrap the cursor's own row and no other. Asserting only
    // that ESC[7m is "present somewhere" would pass even if a neighbouring row were
    // highlighted, so pin it to the exact line and require neighbours to stay plain.
    const cursorLine = lines.findIndex((line) => line.includes(`item-${cursor}`));
    expect(cursorLine).toBeGreaterThanOrEqual(0);
    expect(lines[cursorLine]).toContain(INVERSE);
    lines.forEach((line, index) => {
      if (index !== cursorLine) expect(line).not.toContain(INVERSE);
    });
    highlighted.unmount();

    const plain = render(<ScrollView items={items} height={5} cursor={-1} />);
    expect(plain.lastFrame() ?? "").not.toContain(INVERSE);
    plain.unmount();
  });
});

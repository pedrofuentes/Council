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
    const highlighted = render(<ScrollView items={items} height={5} cursor={2} />);
    // Ink renders `inverse` as the SGR reverse-video sequence (ESC[7m); FORCE_COLOR=3 in tests.
    expect(highlighted.lastFrame() ?? "").toContain("\u001b[7m");
    highlighted.unmount();

    const plain = render(<ScrollView items={items} height={5} cursor={-1} />);
    expect(plain.lastFrame() ?? "").not.toContain("\u001b[7m");
    plain.unmount();
  });
});

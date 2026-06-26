import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { Footer } from "../../../src/tui/components/layout/Footer.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const coloredTheme = resolveTheme({});
const hints = [
  { key: "j/k", label: "move" },
  { key: "↵", label: "open" },
];

describe("Footer", () => {
  it("shows hint keys, labels, and the mode indicator", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" showLabels theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).toContain("move");
    expect(frame).toContain("NAV");
    unmount();
  });

  it("hides labels in icon-only mode but keeps keys", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" showLabels={false} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).not.toContain("move");
    unmount();
  });

  it("sanitizes the status message", () => {
    const { lastFrame, unmount } = render(
      <Footer hints={hints} mode="NAV" status={"saved\u0007 ok"} showLabels theme={theme} />,
    );
    expect(lastFrame() ?? "").not.toContain("\u0007");
    unmount();
  });

  it("defaults to showing labels when showLabels is undefined", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).toContain("move");
    unmount();
  });
});

describe("Footer mode chip visual treatment", () => {
  it("renders the mode badge as an inverse chip when colors are enabled", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" showLabels theme={coloredTheme} />);
    const frame = lastFrame() ?? "";
    // Ink's inverse prop produces \u001b[7m — present only when chip treatment is applied
    expect(frame).toContain("\u001b[7m");
    expect(frame).toContain("NAV");
    unmount();
  });

  it("renders NO inverse chip in NO_COLOR mode — plain text fallback", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" showLabels theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u001b[7m");
    expect(frame).toContain("NAV");
    unmount();
  });
});

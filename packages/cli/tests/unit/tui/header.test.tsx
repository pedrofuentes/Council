import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { Header } from "../../../src/tui/components/layout/Header.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

describe("Header", () => {
  it("shows the breadcrumb, model, and cost in full mode", () => {
    const { lastFrame, unmount } = render(
      <Header breadcrumb="Council ▸ panel" model="claude-sonnet-4.5" premiumRequests={6} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Council ▸ panel");
    expect(frame).toContain("claude-sonnet-4.5");
    expect(frame).toContain("6");
    unmount();
  });

  it("hides model and cost in compact mode", () => {
    const { lastFrame, unmount } = render(
      <Header breadcrumb="Council ▸ panel" model="claude-sonnet-4.5" premiumRequests={6} compact theme={theme} />,
    );
    expect(lastFrame() ?? "").not.toContain("claude-sonnet-4.5");
    unmount();
  });

  it("sanitizes control sequences in the breadcrumb and model", () => {
    const { lastFrame, unmount } = render(
      <Header breadcrumb={"Council\u0007 ▸ p"} model={"m\u001b[31mx"} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    unmount();
  });
});

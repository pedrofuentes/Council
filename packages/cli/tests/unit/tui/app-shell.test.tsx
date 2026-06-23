import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { AppShell } from "../../../src/tui/components/layout/AppShell.js";
import { computeLayout } from "../../../src/tui/lib/breakpoints.js";

describe("AppShell", () => {
  it("renders header, nav, main, and footer when wide", () => {
    const layout = computeLayout({ columns: 140, rows: 40 });
    const { lastFrame, unmount } = render(
      <AppShell
        layout={layout}
        header={<Text>HEADER</Text>}
        footer={<Text>FOOTER</Text>}
        nav={<Text>NAV</Text>}
      >
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    for (const part of ["HEADER", "NAV", "MAIN", "FOOTER"]) expect(frame).toContain(part);
    unmount();
  });

  it("omits the nav when navState is hidden", () => {
    const layout = computeLayout({ columns: 70, rows: 24 }); // hidden
    const { lastFrame, unmount } = render(
      <AppShell layout={layout} header={<Text>H</Text>} footer={<Text>F</Text>} nav={<Text>NAV</Text>}>
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MAIN");
    expect(frame).not.toContain("NAV");
    unmount();
  });

  it("shows a too-narrow warning under 60 cols", () => {
    const layout = computeLayout({ columns: 50, rows: 20 });
    const { lastFrame, unmount } = render(
      <AppShell layout={layout} header={<Text>H</Text>} footer={<Text>F</Text>}>
        <Text>MAIN</Text>
      </AppShell>,
    );
    expect((lastFrame() ?? "").toLowerCase()).toContain("too narrow");
    unmount();
  });
});

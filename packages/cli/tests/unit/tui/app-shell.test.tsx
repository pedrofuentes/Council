import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { AppShell } from "../../../src/tui/components/layout/AppShell.js";
import { computeLayout } from "../../../src/tui/lib/breakpoints.js";
import type { SemanticTheme } from "../../../src/tui/theme/tokens.js";

const id = (s: string): string => s;

// A theme whose primary/muted wrap with detectable sentinels so we can assert
// which pane received the focused (primary) vs unfocused (muted) treatment.
function sentinelTheme(enabled: boolean): SemanticTheme {
  return {
    accent: id,
    muted: (s) => `<<M>>${s}<</M>>`,
    error: id,
    warn: id,
    success: id,
    primary: (s) => `<<P>>${s}<</P>>`,
    secondary: id,
    info: id,
    enabled,
  };
}

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

  it("fills the terminal height, pinning the footer to the bottom row", () => {
    const layout = computeLayout({ columns: 120, rows: 40 });
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
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(40);
    expect(lines[0]).toContain("HEADER");
    expect(lines[lines.length - 1]).toContain("FOOTER");
    unmount();
  });

  it("highlights the focused pane with primary and the unfocused pane with muted when theme is enabled", () => {
    const layout = computeLayout({ columns: 140, rows: 40 });
    const { lastFrame, unmount } = render(
      <AppShell
        layout={layout}
        theme={sentinelTheme(true)}
        focus="main"
        mainTitle="Experts"
        header={<Text>HEADER</Text>}
        footer={<Text>FOOTER</Text>}
        nav={<Text>NAV</Text>}
      >
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    // main pane is focused → its title gets the primary sentinel
    expect(frame).toContain("<<P>>Experts<</P>>");
    // nav pane is unfocused → its title gets the muted sentinel
    expect(frame).toContain("<<M>>Nav<</M>>");
    unmount();
  });

  it("moves the primary highlight to the nav pane when the nav is focused", () => {
    const layout = computeLayout({ columns: 140, rows: 40 });
    const { lastFrame, unmount } = render(
      <AppShell
        layout={layout}
        theme={sentinelTheme(true)}
        focus="nav"
        mainTitle="Experts"
        header={<Text>H</Text>}
        footer={<Text>F</Text>}
        nav={<Text>NAV</Text>}
      >
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("<<P>>Nav<</P>>");
    expect(frame).toContain("<<M>>Experts<</M>>");
    unmount();
  });

  it("does not wrap pane titles in color when the theme is disabled (NO_COLOR)", () => {
    const layout = computeLayout({ columns: 140, rows: 40 });
    const { lastFrame, unmount } = render(
      <AppShell
        layout={layout}
        theme={sentinelTheme(false)}
        focus="main"
        mainTitle="Experts"
        header={<Text>H</Text>}
        footer={<Text>F</Text>}
        nav={<Text>NAV</Text>}
      >
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("<<P>>");
    expect(frame).not.toContain("<<M>>");
    // titles still render as plain text
    expect(frame).toContain("Experts");
    expect(frame).toContain("Nav");
    unmount();
  });

  it("never overflows the pinned terminal height with bordered panes", () => {
    const sizes: readonly (readonly [number, number])[] = [
      [60, 24],
      [80, 24],
      [120, 40],
      [140, 40],
    ];
    for (const [cols, rows] of sizes) {
      const layout = computeLayout({ columns: cols, rows });
      const { lastFrame, unmount } = render(
        <AppShell
          layout={layout}
          theme={sentinelTheme(true)}
          focus="main"
          mainTitle="Experts"
          header={<Text>HEADER</Text>}
          footer={<Text>FOOTER</Text>}
          nav={<Text>NAV</Text>}
        >
          <Text>MAIN</Text>
        </AppShell>,
      );
      const lines = (lastFrame() ?? "").split("\n");
      expect(lines.length).toBeLessThanOrEqual(rows);
      unmount();
    }
  });
});

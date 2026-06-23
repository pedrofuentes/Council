// packages/cli/tests/unit/tui/home-screen.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { HomeScreen } from "../../../src/tui/screens/HomeScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

describe("HomeScreen", () => {
  it("lists recent sessions, counts, and quick actions", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen
        theme={theme}
        data={{
          counts: { sessions: 12, experts: 9, panels: 5 },
          recent: [{ id: "s1", title: "Microservices migration", when: "2d", status: "convened" }],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Microservices migration");
    expect(frame).toContain("12 sessions");
    expect(frame).toContain("Convene");
    unmount();
  });

  it("shows an empty-state CTA when there is nothing yet", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen theme={theme} data={{ counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] }} />,
    );
    expect((lastFrame() ?? "").toLowerCase()).toContain("start your first");
    unmount();
  });

  it("sanitizes session titles", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen
        theme={theme}
        data={{
          counts: { sessions: 1, experts: 0, panels: 0 },
          recent: [{ id: "s1", title: "evil\u0007\u001b[31m", when: "1d", status: "convened" }],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    unmount();
  });

  it("shows ✓ for concluded sessions and • for convened", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen
        theme={theme}
        data={{
          counts: { sessions: 2, experts: 0, panels: 0 },
          recent: [
            { id: "s1", title: "Concluded session", when: "3d", status: "concluded" },
            { id: "s2", title: "Active session", when: "1d", status: "convened" },
          ],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("•");
    unmount();
  });
});

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { StartupBanner } from "../../../src/tui/components/layout/StartupBanner.js";
import type { StartupWarning } from "../../../src/tui/lib/startup-warnings.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("StartupBanner", () => {
  it("renders each warning and the update notice", () => {
    const warnings: readonly StartupWarning[] = [
      { kind: "warning", text: "config key deprecated" },
      { kind: "update", text: "Update available 1.0.0 -> 2.0.0" },
    ];
    const { lastFrame, unmount } = render(<StartupBanner warnings={warnings} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("config key deprecated");
    expect(frame).toContain("Update available 1.0.0 -> 2.0.0");
    unmount();
  });

  it("renders nothing when there are no warnings", () => {
    const { lastFrame, unmount } = render(<StartupBanner warnings={[]} theme={theme} />);
    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
  });

  it("sanitizes untrusted warning text at the sink", () => {
    const warnings: readonly StartupWarning[] = [
      { kind: "warning", text: "alert\u0007\u001b[31m\nSPOOF\u2028end" },
    ];
    const { lastFrame, unmount } = render(<StartupBanner warnings={warnings} theme={theme} />);
    const frame = lastFrame() ?? "";
    // The banner's own <Text> sink must collapse newline/U+2028 and strip
    // BEL/ANSI so an untrusted warning cannot forge a line or inject controls.
    expect(frame).toContain("alert SPOOF end");
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("\u2028");
    unmount();
  });

  it("dismisses on Escape and then renders nothing", async () => {
    const warnings: readonly StartupWarning[] = [{ kind: "warning", text: "dismiss me" }];
    const { lastFrame, stdin, unmount } = render(
      <StartupBanner warnings={warnings} theme={theme} isActive />,
    );
    expect(lastFrame() ?? "").toContain("dismiss me");

    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);

    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
  });

  // #2126 🟡 — PR #2124 wired lazily-loaded panels degraded-template warnings
  // into this banner, but the one-way `dismissed` latch never reset when
  // `props.warnings` grew after the user dismissed the banner, so a warning
  // that arrives post-dismissal (e.g. on Panels-screen mount) never rendered.
  // This re-opened #2111's invisible-warning gap for that sequence.
  it("re-shows the banner with the new warning when the warning set grows after dismissal (#2126)", async () => {
    const initial: readonly StartupWarning[] = [{ kind: "warning", text: "first warning" }];
    const { lastFrame, stdin, rerender, unmount } = render(
      <StartupBanner warnings={initial} theme={theme} isActive />,
    );
    expect(lastFrame() ?? "").toContain("first warning");

    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);
    expect((lastFrame() ?? "").trim()).toBe("");

    const grown: readonly StartupWarning[] = [
      ...initial,
      { kind: "warning", text: "late degraded-template warning" },
    ];
    rerender(<StartupBanner warnings={grown} theme={theme} isActive />);
    await sleep(20);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("late degraded-template warning");
    expect(frame).toContain("first warning");
    unmount();
  });

  it("does not re-show the banner when re-rendered with the same (already-dismissed) warnings", async () => {
    const warnings: readonly StartupWarning[] = [{ kind: "warning", text: "steady warning" }];
    const { lastFrame, stdin, rerender, unmount } = render(
      <StartupBanner warnings={warnings} theme={theme} isActive />,
    );
    expect(lastFrame() ?? "").toContain("steady warning");

    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);
    expect((lastFrame() ?? "").trim()).toBe("");

    // Re-render with a brand-new array reference but identical content: must
    // not resurrect the dismissed banner (no spurious re-show).
    rerender(
      <StartupBanner
        warnings={[{ kind: "warning", text: "steady warning" }]}
        theme={theme}
        isActive
      />,
    );
    await sleep(20);
    expect((lastFrame() ?? "").trim()).toBe("");

    // A second identical re-render completes (and stays hidden), proving the
    // dismiss/re-show logic is stable rather than looping.
    rerender(
      <StartupBanner
        warnings={[{ kind: "warning", text: "steady warning" }]}
        theme={theme}
        isActive
      />,
    );
    await sleep(20);
    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
  });
});

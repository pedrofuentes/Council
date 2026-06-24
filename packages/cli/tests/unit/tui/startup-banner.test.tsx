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
});

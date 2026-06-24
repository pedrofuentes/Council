import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { HelpModal } from "../../../src/tui/components/overlays/HelpModal.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const entries = [
  { keys: "j/k", description: "move" },
  { keys: "Esc", description: "back" },
];
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const noop = (): void => undefined;

describe("HelpModal", () => {
  it("lists keybindings", () => {
    const { lastFrame, unmount } = render(
      <HelpModal entries={entries} onClose={noop} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).toContain("move");
    unmount();
  });

  it("closes on Esc (real-timer wait — Ink buffers a lone Esc)", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <HelpModal
        entries={entries}
        onClose={() => {
          closed = true;
        }}
        theme={theme}
      />,
    );
    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);
    expect(closed).toBe(true);
    unmount();
  });

  it("closes on ? as well", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <HelpModal
        entries={entries}
        onClose={() => {
          closed = true;
        }}
        theme={theme}
      />,
    );
    await new Promise((r) => setImmediate(r));
    stdin.write("?");
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(true);
    unmount();
  });

  it("renders a contextual 'This screen' section above the global list", () => {
    const context = [
      { keys: "m", description: "Edit members" },
      { keys: "v", description: "Convene" },
    ];
    const { lastFrame, unmount } = render(
      <HelpModal entries={entries} contextEntries={context} onClose={noop} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("This screen");
    expect(frame).toContain("Edit members");
    expect(frame).toContain("Convene");
    // the global list is still present
    expect(frame).toContain("Keyboard shortcuts");
    expect(frame).toContain("move");
    // the contextual section is rendered ahead of the global heading
    expect(frame.indexOf("This screen")).toBeLessThan(frame.indexOf("Keyboard shortcuts"));
    unmount();
  });

  it("omits the contextual section when there are no context entries", () => {
    const { lastFrame, unmount } = render(
      <HelpModal entries={entries} contextEntries={[]} onClose={noop} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("This screen");
    expect(frame).toContain("Keyboard shortcuts");
    unmount();
  });
});

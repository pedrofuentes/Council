import React from "react";
import { describe, expect, it, vi } from "vitest";
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

  // Regression coverage for #1576: useInput is gated by `isActive`, but prior
  // coverage only exercised the active (default) path. These two tests pin the
  // gate on both sides — the positive control proves Esc/? WOULD close the
  // modal, so the isActive={false} assertion below is not vacuous.
  describe("isActive gating (#1576)", () => {
    it("calls onClose for Esc and ? when isActive is true (positive control)", async () => {
      const onClose = vi.fn();
      const { stdin, unmount } = render(
        <HelpModal entries={entries} onClose={onClose} theme={theme} isActive={true} />,
      );
      await sleep(20);
      stdin.write("\u001b"); // Esc — Ink buffers a lone Esc briefly before firing key.escape
      await sleep(120);
      expect(onClose).toHaveBeenCalledTimes(1);

      stdin.write("?");
      await new Promise((r) => setImmediate(r));
      expect(onClose).toHaveBeenCalledTimes(2);
      unmount();
    });

    it("does NOT call onClose for Esc or ? when isActive is false", async () => {
      const onClose = vi.fn();
      const { stdin, unmount } = render(
        <HelpModal entries={entries} onClose={onClose} theme={theme} isActive={false} />,
      );
      await sleep(20);
      stdin.write("\u001b"); // same Esc sequence as the positive control above
      await sleep(120);
      expect(onClose).not.toHaveBeenCalled();

      stdin.write("?");
      await new Promise((r) => setImmediate(r));
      expect(onClose).not.toHaveBeenCalled();
      unmount();
    });
  });
});

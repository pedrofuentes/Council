import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ActionMenu } from "../../../src/tui/components/overlays/ActionMenu.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const items = [
  { key: "c", label: "Chat" },
  { key: "e", label: "Edit" },
  { key: "d", label: "Delete" },
];

const noop = (): void => undefined;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("ActionMenu", () => {
  it("renders all items with their keys and labels", async () => {
    const { lastFrame, unmount } = render(
      <ActionMenu items={items} isActive onSelect={noop} onClose={noop} theme={theme} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Chat");
    expect(frame).toContain("Edit");
    expect(frame).toContain("Delete");
    unmount();
  });

  it("calls onSelect with the first item key when Enter is pressed", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <ActionMenu
        items={items}
        isActive
        onSelect={(k) => {
          selected = k;
        }}
        onClose={noop}
        theme={theme}
      />,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("c");
    unmount();
  });

  it("moves selection down with the down arrow and selects the second item", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <ActionMenu
        items={items}
        isActive
        onSelect={(k) => {
          selected = k;
        }}
        onClose={noop}
        theme={theme}
      />,
    );
    await flush();
    stdin.write("\u001b[B"); // down arrow
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("e");
    unmount();
  });

  it("moves selection up with the up arrow after moving down", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <ActionMenu
        items={items}
        isActive
        onSelect={(k) => {
          selected = k;
        }}
        onClose={noop}
        theme={theme}
      />,
    );
    await flush();
    stdin.write("\u001b[B"); // down -> index 1
    await flush();
    stdin.write("\u001b[A"); // up -> index 0
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("c");
    unmount();
  });

  it("moves selection with j/k vim keys", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <ActionMenu
        items={items}
        isActive
        onSelect={(k) => {
          selected = k;
        }}
        onClose={noop}
        theme={theme}
      />,
    );
    await flush();
    stdin.write("j"); // down -> index 1
    await flush();
    stdin.write("j"); // down -> index 2
    await flush();
    stdin.write("k"); // up -> index 1
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("e");
    unmount();
  });

  it("calls onClose when Esc is pressed", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <ActionMenu
        items={items}
        isActive
        onSelect={noop}
        onClose={() => {
          closed = true;
        }}
        theme={theme}
      />,
    );
    await sleep(20);
    stdin.write("\u001b"); // Esc — Ink buffers a lone Esc for disambiguation
    await sleep(120);
    expect(closed).toBe(true);
    unmount();
  });

  it("sanitizes item labels to prevent control character injection", async () => {
    const evil = [{ key: "x", label: "Evil\u001b[31m Label\nMultiline" }];
    const { lastFrame, unmount } = render(
      <ActionMenu items={evil} isActive onSelect={noop} onClose={noop} theme={theme} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[31m");
    expect(frame).toContain("Evil");
    expect(frame).toContain("Label");
    unmount();
  });

  it("does not respond to input when isActive is false", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <ActionMenu
        items={items}
        isActive={false}
        onSelect={(k) => {
          selected = k;
        }}
        onClose={noop}
        theme={theme}
      />,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBeUndefined();
    unmount();
  });
});

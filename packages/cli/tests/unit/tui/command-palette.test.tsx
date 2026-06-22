import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { CommandPalette } from "../../../src/tui/components/overlays/CommandPalette.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const commands = [
  { id: "new", label: "New Session" },
  { id: "exp", label: "Create Expert" },
  { id: "set", label: "Settings" },
];

const noop = (): void => undefined;

describe("CommandPalette", () => {
  it("filters commands by fuzzy query and selects on Enter", async () => {
    let selected: string | undefined;
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette commands={commands} onSelect={(id) => { selected = id; }} onClose={noop} />,
    );
    await flush();
    stdin.write("nse");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("New Session");
    expect(frame).not.toContain("Settings");
    stdin.write("\r");
    await flush();
    expect(selected).toBe("new");
    unmount();
  });

  it("moves the selection with the down arrow before selecting", async () => {
    let selected: string | undefined;
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette commands={commands} onSelect={(id) => { selected = id; }} onClose={noop} />,
    );
    await flush();
    stdin.write("se"); // matches "Settings" (higher score) then "New Session"; excludes "Create Expert"
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Settings");
    expect(frame).toContain("New Session");
    expect(frame).not.toContain("Create Expert");
    stdin.write("\u001b[B"); // down arrow -> second result
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("new");
    unmount();
  });

  it("sanitizes command labels for single-line display", async () => {
    const evil = [{ id: "x", label: "Ev\u0007il\u001b[31m Cmd" }];
    const { lastFrame, unmount } = render(
      <CommandPalette commands={evil} onSelect={noop} onClose={noop} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    unmount();
  });

  it("closes on Esc", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <CommandPalette commands={commands} onSelect={noop} onClose={() => { closed = true; }} />,
    );
    await sleep(20);
    stdin.write("\u001b"); // Esc — Ink delivers key.escape only after its real-time disambiguation timeout
    await sleep(120);
    expect(closed).toBe(true);
    unmount();
  });

  it("moves the selection up with the up arrow", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <CommandPalette commands={commands} onSelect={(id) => { selected = id; }} onClose={noop} />,
    );
    await flush();
    stdin.write("se");
    await flush();
    stdin.write("\u001b[B"); // down -> second result (New Session)
    await flush();
    stdin.write("\u001b[A"); // up -> back to first result (Settings)
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("set");
    unmount();
  });

  it("edits the query with Backspace", async () => {
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette commands={commands} onSelect={noop} onClose={noop} />,
    );
    await flush();
    stdin.write("zzz"); // matches no command
    await flush();
    expect(lastFrame() ?? "").not.toContain("Settings");
    stdin.write("\u007f"); // backspace
    stdin.write("\u007f");
    stdin.write("\u007f"); // query now empty -> all commands shown
    await flush();
    expect(lastFrame() ?? "").toContain("Settings");
    unmount();
  });
});

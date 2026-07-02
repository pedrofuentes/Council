import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { createPanelsDataSource } from "../../../src/tui/adapters/panels-data.js";
import {
  createRuntimeWarningChannel,
  useRuntimeWarnings,
  type RuntimeWarningChannel,
} from "../../../src/tui/index.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

// A minimal TUI surface that renders whatever the channel accumulates. Stands in
// for the real `startupWarnings` → StartupBanner sink so the test proves the
// warning reaches a RENDERED channel (not stderr), reactively.
function WarningsProbe({
  channel,
}: {
  readonly channel: RuntimeWarningChannel;
}): React.ReactElement {
  const warnings = useRuntimeWarnings(channel);
  return (
    <>
      {warnings.map((warning, index) => (
        <Text key={index}>{warning.text}</Text>
      ))}
    </>
  );
}

// #2111 🟡 1 — the panels degraded-template warning defaulted to `console.warn`
// (stderr), which is invisible / corrupting under the alternate-screen TUI, and
// callers at index.tsx:243 wired no sink. `createRuntimeWarningChannel` is the
// TUI-visible sink index.tsx now injects there; it must surface warnings to a
// rendered channel reactively and stay sanitized/single-line.
describe("createRuntimeWarningChannel — TUI-visible warning wiring (#2111)", () => {
  it("renders nothing until a warning is surfaced", async () => {
    const channel = createRuntimeWarningChannel();
    const { lastFrame } = render(<WarningsProbe channel={channel} />);
    await flush();
    expect(lastFrame() ?? "").toBe("");
    expect(channel.snapshot()).toEqual([]);
  });

  it("reactively surfaces a warning to the rendered channel after the sink fires", async () => {
    const channel = createRuntimeWarningChannel();
    const { lastFrame } = render(<WarningsProbe channel={channel} />);
    await flush();

    channel.onWarning("Skipped 1 of 1 panel template(s) that failed to load: broken: corrupt");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("broken");
    expect(frame).toContain("corrupt");
  });

  it("drops a message that is blank once sanitized (never an empty banner row)", async () => {
    const channel = createRuntimeWarningChannel();
    const { lastFrame } = render(<WarningsProbe channel={channel} />);
    await flush();

    channel.onWarning("\u0007\u001b[2K   \t  "); // control/ANSI + whitespace only
    await flush();

    expect(lastFrame() ?? "").toBe("");
    expect(channel.snapshot()).toEqual([]);
  });

  it("accumulates multiple warnings in arrival order", async () => {
    const channel = createRuntimeWarningChannel();
    const { lastFrame } = render(<WarningsProbe channel={channel} />);

    channel.onWarning("first warning");
    channel.onWarning("second warning");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("first warning");
    expect(frame).toContain("second warning");
    expect(channel.snapshot()).toHaveLength(2);
  });

  // End-to-end: the exact wiring index.tsx uses — `createPanelsDataSource({ …,
  // onWarning: channel.onWarning })` — must deliver the degraded-template
  // warning (name + reason) to the rendered channel, sanitized to one line.
  it("delivers the panels degraded-template warning (name + reason) to the TUI, sanitized (#2111)", async () => {
    const channel = createRuntimeWarningChannel();
    const { lastFrame } = render(<WarningsProbe channel={channel} />);

    const dataSource = createPanelsDataSource({
      library: {
        findAll: async () => [],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map(),
      },
      experts: { get: async () => null },
      listTemplates: async () => ["al\u001b[31mpha\u0007-\u202etemplate"],
      loadTemplate: async () => {
        throw new Error("mal\u0000formed\u2028reason\u202c");
      },
      onWarning: channel.onWarning,
    });

    await expect(dataSource.loadList()).resolves.toEqual([]);
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("alpha-template");
    expect(frame).toContain("malformed reason");
    // No control / bidi bytes reach the terminal row. (Ink lays rows out with
    // newlines, so \n / \r / \t are excluded from this control-byte assertion.)
    expect(frame).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
    );
  });

  it("stops notifying a subscriber after it unsubscribes", async () => {
    const channel = createRuntimeWarningChannel();
    let notifications = 0;
    const unsubscribe = channel.subscribe(() => {
      notifications += 1;
    });

    channel.onWarning("one");
    unsubscribe();
    channel.onWarning("two");

    expect(notifications).toBe(1);
    expect(channel.snapshot()).toHaveLength(2);
  });
});

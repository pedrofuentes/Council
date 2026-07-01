/**
 * Failing tests for Ink renderer issue #236 — full state propagated to
 * every historical ExpertCard.
 *
 * The fix derives stable, narrow props (the expert "lookup") once and wraps
 * completed static rows in `React.memo`, so a `turn.delta` (which produces a
 * fresh `DebateState` object every token) no longer changes the props handed
 * to already-completed rows.
 *
 * RED at the `test(ink)` commit: `createExpertLookup` and `StaticItemView`
 * are not yet exported from InkRenderer.tsx.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  DebateApp,
  INITIAL_STATE,
  createExpertLookup,
  StaticItemView,
  reduce,
} from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { DebateEvent } from "../../../../../src/core/types.js";

async function* stream(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("createExpertLookup #236 — narrow, stable derived props", () => {
  it("exposes only the expert-identity fields, each by reference from state", () => {
    const state = reduce(INITIAL_STATE, {
      kind: "panel.assembled",
      experts: [
        { slug: "alice", displayName: "Alice", model: "gpt-5" },
        { slug: "user", displayName: "You", model: "", participantKind: "human" },
      ],
    });
    const lookup = createExpertLookup(state);

    expect(lookup.panel).toBe(state.panel);
    expect(lookup.expertIndex).toBe(state.expertIndex);
    expect(lookup.humanSlugs).toBe(state.humanSlugs);
    expect(lookup.displayNames).toBe(state.displayNames);
    // It must NOT carry churny fields (activeTurn/completedItems/cost/...),
    // otherwise memoized rows would re-render on every delta.
    expect(Object.keys(lookup).sort()).toEqual([
      "displayNames",
      "expertIndex",
      "humanSlugs",
      "panel",
    ]);
  });

  it("stays referentially stable across a streaming turn.delta", () => {
    let state = reduce(INITIAL_STATE, {
      kind: "panel.assembled",
      experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
    });
    state = reduce(state, { kind: "round.start", round: 0 });
    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 });
    state = reduce(state, { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "done" });
    const before = createExpertLookup(state);

    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 1 });
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "streaming token" });
    const after = createExpertLookup(state);

    // Every field feeding a completed row must be the same reference, so a
    // memoized StaticItemView sees identical props and skips re-rendering.
    expect(after.panel).toBe(before.panel);
    expect(after.expertIndex).toBe(before.expertIndex);
    expect(after.humanSlugs).toBe(before.humanSlugs);
    expect(after.displayNames).toBe(before.displayNames);
  });
});

describe("StaticItemView #236 — memoized completed rows", () => {
  it("is wrapped in React.memo", () => {
    expect((StaticItemView as unknown as { readonly $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("still renders a completed turn's label and body (memo preserves output)", async () => {
    const ui = render(
      <DebateApp
        events={stream(
          {
            kind: "panel.assembled",
            experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
          },
          { kind: "round.start", round: 0 },
          { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
          { kind: "turn.delta", expertSlug: "alice", text: "hello world" },
          { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hello world" },
        )}
      />,
    );
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("[1] Alice");
    expect(frame).toContain("hello world");
    ui.unmount();
  });
});

describe("reduce #236 invariant — expert-identity fields never churn on deltas", () => {
  it("keeps panel/expertIndex/humanSlugs/displayNames referentially unchanged across deltas", () => {
    let state = reduce(INITIAL_STATE, {
      kind: "panel.assembled",
      experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
    });
    const { panel, expertIndex, humanSlugs, displayNames } = state;

    state = reduce(state, { kind: "round.start", round: 0 });
    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 });
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "a" });
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "b" });

    expect(state.panel).toBe(panel);
    expect(state.expertIndex).toBe(expertIndex);
    expect(state.humanSlugs).toBe(humanSlugs);
    expect(state.displayNames).toBe(displayNames);
  });
});

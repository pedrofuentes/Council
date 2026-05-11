/**
 * Tests for visibility scoping (ROADMAP §2.6).
 *
 * `filterPriorTurns()` controls which historical turns are exposed to
 * a given expert before their next turn. Three scopes are supported:
 *
 *   - "all"         — no filtering (status-quo behaviour).
 *   - "same-round"  — only turns from the current round.
 *   - "recent"      — most recent N turns across all rounds.
 *
 * The helper is pure: it does not mutate the input array and is safe
 * to call repeatedly with the same arguments.
 */
import { describe, expect, it } from "vitest";

import { filterPriorTurns } from "../../../../src/core/context/visibility.js";
import type { PriorTurnRecord } from "../../../../src/core/moderator/strategy.js";

function turn(slug: string, round: number, content = `${slug}-r${round}`): PriorTurnRecord {
  return { expertSlug: slug, displayName: slug.toUpperCase(), content, round };
}

const TURNS: readonly PriorTurnRecord[] = [
  turn("cto", 0),
  turn("pm", 0),
  turn("cto", 1),
  turn("pm", 1),
  turn("cto", 2),
  turn("pm", 2),
];

describe("filterPriorTurns — 'all' scope", () => {
  it("returns every prior turn unchanged", () => {
    const out = filterPriorTurns(TURNS, "cto", 2, { scope: "all" });
    expect(out).toEqual(TURNS);
  });

  it("returns empty for empty input", () => {
    expect(filterPriorTurns([], "cto", 0, { scope: "all" })).toEqual([]);
  });
});

describe("filterPriorTurns — 'same-round' scope", () => {
  it("filters to turns in the current round only", () => {
    const out = filterPriorTurns(TURNS, "cto", 1, { scope: "same-round" });
    expect(out.map((t) => `${t.expertSlug}-${t.round}`)).toEqual(["cto-1", "pm-1"]);
  });

  it("returns empty when there are no turns in the current round yet", () => {
    const out = filterPriorTurns(TURNS, "cto", 5, { scope: "same-round" });
    expect(out).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(filterPriorTurns([], "cto", 0, { scope: "same-round" })).toEqual([]);
  });
});

describe("filterPriorTurns — 'recent' scope", () => {
  it("returns the most recent N turns (default 10) when input is smaller", () => {
    const out = filterPriorTurns(TURNS, "cto", 2, { scope: "recent" });
    expect(out).toEqual(TURNS);
  });

  it("limits to the last N turns when maxPriorTurns is provided", () => {
    const out = filterPriorTurns(TURNS, "cto", 2, { scope: "recent", maxPriorTurns: 3 });
    expect(out.map((t) => `${t.expertSlug}-${t.round}`)).toEqual([
      "pm-1",
      "cto-2",
      "pm-2",
    ]);
  });

  it("uses 10 as the default maxPriorTurns", () => {
    const long: PriorTurnRecord[] = [];
    for (let i = 0; i < 25; i++) long.push(turn("cto", i));
    const out = filterPriorTurns(long, "cto", 24, { scope: "recent" });
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual(turn("cto", 15));
    expect(out[9]).toEqual(turn("cto", 24));
  });

  it("returns empty for empty input", () => {
    expect(filterPriorTurns([], "cto", 0, { scope: "recent" })).toEqual([]);
  });

  it("returns empty when maxPriorTurns is 0", () => {
    const out = filterPriorTurns(TURNS, "cto", 2, { scope: "recent", maxPriorTurns: 0 });
    expect(out).toEqual([]);
  });
});

describe("filterPriorTurns — purity", () => {
  it("does not mutate the input array", () => {
    const snapshot = TURNS.slice();
    filterPriorTurns(TURNS, "cto", 1, { scope: "same-round" });
    filterPriorTurns(TURNS, "cto", 1, { scope: "recent", maxPriorTurns: 2 });
    expect(TURNS).toEqual(snapshot);
  });
});

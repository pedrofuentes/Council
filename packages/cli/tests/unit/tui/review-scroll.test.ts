import { describe, expect, it } from "vitest";

import { reviewScroll } from "../../../src/tui/lib/review-scroll.js";

describe("reviewScroll", () => {
  it("↑/up from live with 5 items: enters review, cursor at second-to-last", () => {
    expect(reviewScroll({ followLive: true, cursor: 0 }, "up", 5)).toEqual({
      followLive: false,
      cursor: 3, // lastIndex - 1 = 4 - 1
    });
  });

  it("↑/up from review: moves cursor up by one", () => {
    expect(reviewScroll({ followLive: false, cursor: 3 }, "up", 5)).toEqual({
      followLive: false,
      cursor: 2,
    });
  });

  it("↑/up when cursor is already at 0: clamps to 0 (stays in review)", () => {
    expect(reviewScroll({ followLive: false, cursor: 0 }, "up", 5)).toEqual({
      followLive: false,
      cursor: 0,
    });
  });

  it("↑/up from live with a single item: enters review, cursor clamps to 0", () => {
    expect(reviewScroll({ followLive: true, cursor: 0 }, "up", 1)).toEqual({
      followLive: false,
      cursor: 0, // lastIndex - 1 = 0 - 1 = -1, clamped to 0
    });
  });

  it("↓/down from review: moves cursor down without reaching last line", () => {
    expect(reviewScroll({ followLive: false, cursor: 2 }, "down", 5)).toEqual({
      followLive: false,
      cursor: 3,
    });
  });

  it("↓/down from review when next step reaches last line: resumes live", () => {
    expect(reviewScroll({ followLive: false, cursor: 3 }, "down", 5)).toEqual({
      followLive: true,
      cursor: 4, // returned to lastIndex
    });
  });

  it("↓/down from review when already at last line: resumes live", () => {
    expect(reviewScroll({ followLive: false, cursor: 4 }, "down", 5)).toEqual({
      followLive: true,
      cursor: 4,
    });
  });

  it("↓/down from live mode: no-op (already following bottom)", () => {
    const state = { followLive: true, cursor: 0 };
    expect(reviewScroll(state, "down", 5)).toStrictEqual(state);
  });

  it("end/G: resumes live, cursor set to last line", () => {
    expect(reviewScroll({ followLive: false, cursor: 2 }, "end", 5)).toEqual({
      followLive: true,
      cursor: 4,
    });
  });

  it("end/G from live: idempotent — keeps live, cursor updates to last line", () => {
    expect(reviewScroll({ followLive: true, cursor: 0 }, "end", 5)).toEqual({
      followLive: true,
      cursor: 4,
    });
  });

  it("↑/up with 0 total: no-op (nothing to review)", () => {
    const state = { followLive: true, cursor: 0 };
    expect(reviewScroll(state, "up", 0)).toStrictEqual(state);
  });

  it("↓/down with 0 total: no-op", () => {
    const state = { followLive: false, cursor: 0 };
    expect(reviewScroll(state, "down", 0)).toStrictEqual(state);
  });

  it("end with 0 total: no-op", () => {
    const state = { followLive: true, cursor: 0 };
    expect(reviewScroll(state, "end", 0)).toStrictEqual(state);
  });
});

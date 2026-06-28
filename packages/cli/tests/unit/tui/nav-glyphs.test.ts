import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "../../../src/tui/router/AppRouter.js";

const VS16 = "\uFE0F";

function isEmojiPresentation(glyph: string): boolean {
  const codepoints = [...glyph];
  // Full-width emoji from the astral plane render double-width on their own.
  if (codepoints.some((c) => (c.codePointAt(0) ?? 0) >= 0x1f000)) return true;
  // Text-default symbols (e.g. U+2696, U+2699) need a VS16 to render as a
  // double-width emoji; without it they hug their label with no visible gap.
  return glyph.includes(VS16);
}

describe("LeftNav glyphs", () => {
  it("every nav glyph uses emoji presentation so the icon and label keep a gap", () => {
    for (const item of NAV_ITEMS) {
      expect(isEmojiPresentation(item.glyph), `${item.label} glyph "${item.glyph}"`).toBe(true);
    }
  });

  it("the text-default symbols carry a variation selector", () => {
    const debates = NAV_ITEMS.find((i) => i.label === "Debates");
    const settings = NAV_ITEMS.find((i) => i.label === "Settings");
    expect(debates?.glyph).toContain(VS16);
    expect(settings?.glyph).toContain(VS16);
  });
});

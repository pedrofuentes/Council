import { describe, expect, it } from "vitest";

import { computeLayout } from "../../../src/tui/lib/breakpoints.js";

describe("computeLayout", () => {
  it("expands the nav on wide terminals", () => {
    const l = computeLayout({ columns: 140, rows: 40 });
    expect(l.navState).toBe("expanded");
    expect(l.compactHeader).toBe(false);
    expect(l.footerLabels).toBe(true);
    expect(l.tooNarrow).toBe(false);
    expect(l.mainWidth).toBe(140 - 14);
  });

  it("uses the icon rail and compact header at medium width", () => {
    const l = computeLayout({ columns: 100, rows: 30 });
    expect(l.navState).toBe("rail");
    expect(l.compactHeader).toBe(true);
    expect(l.mainWidth).toBe(100 - 3);
  });

  it("hides the nav and footer labels when narrow", () => {
    const l = computeLayout({ columns: 70, rows: 24 });
    expect(l.navState).toBe("hidden");
    expect(l.footerLabels).toBe(false);
    expect(l.tooNarrow).toBe(false);
    expect(l.mainWidth).toBe(70);
  });

  it("flags too-narrow terminals and not normal ones", () => {
    expect(computeLayout({ columns: 50, rows: 20 }).tooNarrow).toBe(true);
    expect(computeLayout({ columns: 80, rows: 20 }).tooNarrow).toBe(false);
  });

  it("applies breakpoints at exact boundaries", () => {
    expect(computeLayout({ columns: 120, rows: 40 }).navState).toBe("expanded");
    expect(computeLayout({ columns: 119, rows: 40 }).navState).toBe("rail");
    expect(computeLayout({ columns: 80, rows: 40 }).navState).toBe("rail");
    expect(computeLayout({ columns: 79, rows: 40 }).navState).toBe("hidden");
    expect(computeLayout({ columns: 60, rows: 40 }).tooNarrow).toBe(false);
    expect(computeLayout({ columns: 59, rows: 40 }).tooNarrow).toBe(true);
  });

  it("honors a manual nav override over the adaptive default", () => {
    const l = computeLayout({ columns: 140, rows: 40, navOverride: "hidden" });
    expect(l.navState).toBe("hidden");
    expect(l.mainWidth).toBe(140);
  });
});

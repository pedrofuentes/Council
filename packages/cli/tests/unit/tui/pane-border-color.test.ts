import { describe, expect, it } from "vitest";

import { paneBorderColor } from "../../../src/tui/components/layout/AppShell.js";
import type { SemanticTheme } from "../../../src/tui/theme/tokens.js";

const id = (s: string): string => s;

function makeTheme(enabled: boolean): SemanticTheme {
  return {
    accent: id,
    muted: id,
    error: id,
    warn: id,
    success: id,
    primary: id,
    secondary: id,
    info: id,
    enabled,
  };
}

describe("paneBorderColor", () => {
  it("returns the focused/primary color name when focused and theme is enabled", () => {
    const color = paneBorderColor(true, makeTheme(true));
    expect(color).toBe("cyan");
  });

  it("returns the unfocused/muted color name when unfocused and theme is enabled", () => {
    const color = paneBorderColor(false, makeTheme(true));
    expect(color).toBe("gray");
  });

  it("focused and unfocused colors are distinct (negative control)", () => {
    const focused = paneBorderColor(true, makeTheme(true));
    const unfocused = paneBorderColor(false, makeTheme(true));
    expect(focused).not.toBe(unfocused);
  });

  it("returns undefined when theme.enabled is false (NO_COLOR / TERM=dumb)", () => {
    const color = paneBorderColor(true, makeTheme(false));
    expect(color).toBeUndefined();
  });

  it("returns undefined for unfocused pane when theme.enabled is false", () => {
    const color = paneBorderColor(false, makeTheme(false));
    expect(color).toBeUndefined();
  });
});

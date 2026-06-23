import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { PlaceholderScreen } from "../../../src/tui/screens/PlaceholderScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

describe("PlaceholderScreen", () => {
  it("renders the title and a coming-soon note", () => {
    const { lastFrame } = render(<PlaceholderScreen title="Panels" theme={resolveTheme({})} />);
    expect(lastFrame()).toContain("Panels");
    expect(lastFrame()).toMatch(/Coming soon/i);
  });
});

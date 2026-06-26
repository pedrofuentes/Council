import { describe, expect, it } from "vitest";

import { resolveEscape } from "../../../src/tui/router/resolve-escape.js";

describe("resolveEscape", () => {
  it("closes the help overlay first when help is open", () => {
    // Help precedence wins regardless of the current route.
    expect(resolveEscape({ mode: "help", atHome: true })).toBe("closeHelp");
    expect(resolveEscape({ mode: "help", atHome: false })).toBe("closeHelp");
  });

  it("navigates back when help is closed and not on the home route", () => {
    expect(resolveEscape({ mode: "nav", atHome: false })).toBe("back");
  });

  it("quits when help is closed and already on the home route", () => {
    expect(resolveEscape({ mode: "nav", atHome: true })).toBe("quit");
  });
});

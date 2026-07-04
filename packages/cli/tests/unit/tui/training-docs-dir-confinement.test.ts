import path from "node:path";
import { describe, expect, it } from "vitest";

import { toSingleLineDisplay } from "../../../src/cli/strip-control-chars.js";
import { resolveConfinedExpertDocsDir } from "../../../src/tui/index.js";

const DATA_HOME = "/council-data";

const TERMINAL_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

describe("resolveConfinedExpertDocsDir", () => {
  it("returns <dataHome>/experts/<slug>/docs for a well-formed slug", () => {
    expect(resolveConfinedExpertDocsDir(DATA_HOME, "cto")).toBe(
      path.join(DATA_HOME, "experts", "cto", "docs"),
    );
  });

  it("rejects a traversal slug that resolves outside the experts root", () => {
    expect(() => resolveConfinedExpertDocsDir(DATA_HOME, "../../etc")).toThrow(
      /escapes experts directory/,
    );
  });

  it("rejects a parent-dir slug that climbs above experts", () => {
    expect(() => resolveConfinedExpertDocsDir(DATA_HOME, "..")).toThrow(
      /escapes experts directory/,
    );
  });

  it("sanitizes control/bidi bytes in the escaping slug echoed back to the terminal error", () => {
    // A traversal slug carrying every terminal-injection vector from #1663.
    const adversarial = "../../evil\u001B[31mANSI\u009BC1\rCR\nLF\u2028LS\u202Ebidi\u2066iso";

    let caught: unknown;
    try {
      resolveConfinedExpertDocsDir(DATA_HOME, adversarial);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The sanitized slug is present verbatim ...
    expect(message).toContain(toSingleLineDisplay(adversarial));
    // ... and NO raw control/bidi bytes or line breaks survive into the message.
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
  });
});

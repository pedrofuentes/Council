import { describe, expect, it } from "vitest";

import { toSingleLineDisplay } from "../../../src/cli/strip-control-chars.js";
import { buildMissingExpertError } from "../../../src/tui/index.js";

const TERMINAL_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

describe("buildMissingExpertError", () => {
  it("names a well-formed missing expert slug verbatim", () => {
    expect(buildMissingExpertError("cto").message).toBe('Panel references missing expert "cto"');
  });

  it("sanitizes control/bidi bytes in the DB-sourced slug echoed to the terminal error", () => {
    // A DB/library-sourced slug carrying every terminal-injection vector from
    // #1663, echoed back into the convene-persist "missing expert" error.
    const adversarial = "evil\u001B[31mANSI\u009BC1\rCR\nLF\u2028LS\u202Ebidi\u2066iso\u200Bzw";

    const error = buildMissingExpertError(adversarial);

    expect(error).toBeInstanceOf(Error);
    const message = error.message;
    // The sanitized slug is present verbatim ...
    expect(message).toContain(toSingleLineDisplay(adversarial));
    // ... and NO raw control/bidi bytes or line breaks survive into the message.
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
  });
});

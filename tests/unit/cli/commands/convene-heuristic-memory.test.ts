/**
 * RED — convene CLI must accept --heuristic-memory to opt back into
 * the pre-LLM heuristic memory recall behavior. The default (LLM
 * extraction post-debate) is on for normal users.
 *
 * The flag is wired through ConveneOptions and made accessible to
 * downstream code that decides whether to run extractMemoryLLM.
 */
import { describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";

describe("convene CLI — --heuristic-memory flag", () => {
  it("declares the --heuristic-memory option in the Commander spec", () => {
    const cmd = buildConveneCommand();
    const opt = cmd.options.find((o) => o.long === "--heuristic-memory");
    expect(opt).toBeDefined();
    // Boolean opt-out style (no value).
    expect(opt?.required).not.toBe(true);
  });
});

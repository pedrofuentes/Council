/**
 * Test for convene --model option help text (#2423).
 *
 * Verifies that the --model option description documents its precedence
 * over template and expert defaults (Finding from sentinel-2422-69ebf288-01).
 */
import { describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";

describe("convene --model help text documents precedence (#2423)", () => {
  it("documents that --model overrides template and expert defaults", () => {
    const cmd = buildConveneCommand();

    const modelOpt = cmd.options.find((o) => o.long === "--model");
    expect(modelOpt).toBeDefined();
    if (!modelOpt) throw new Error("--model option not found");

    const desc = modelOpt.description.toLowerCase();
    
    // The description should mention precedence/override behavior
    const documentsPrecedence =
      (desc.includes("override") || desc.includes("precedence")) &&
      (desc.includes("template") || desc.includes("expert"));

    expect(documentsPrecedence).toBe(true);
  });

  it("--model description still references config as default fallback", () => {
    const cmd = buildConveneCommand();

    const modelOpt = cmd.options.find((o) => o.long === "--model");
    expect(modelOpt).toBeDefined();
    if (!modelOpt) throw new Error("--model option not found");

    // Should still mention config as the ultimate fallback
    expect(modelOpt.description.toLowerCase()).toContain("config");
  });
});

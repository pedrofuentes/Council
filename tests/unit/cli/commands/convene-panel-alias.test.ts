/**
 * Tests for `--panel` alias for `--template` option (Finding 15).
 *
 * Users think in terms of "panels" not "templates". Both
 * `--panel` and `--template` should work, with backward compatibility.
 */
import { describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";

describe("convene --panel alias", () => {
  function makeMockEngineFactory(): () => CouncilEngine {
    return () =>
      new MockEngine({
        responses: {},
      });
  }

  it("registers --panel option alongside --template", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    
    const panelOpt = cmd.options.find((o) => o.long === "--panel");
    const templateOpt = cmd.options.find((o) => o.long === "--template");
    
    expect(panelOpt).toBeDefined();
    expect(templateOpt).toBeDefined();
    expect(panelOpt?.description).toMatch(/template|panel/i);
  });

  it("shows both --panel and --template in help text", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    const helpText = cmd.helpInformation();
    
    expect(helpText).toMatch(/--panel/);
    expect(helpText).toMatch(/--template/);
  });
});

/**
 * Regression guard for `council chat`'s addHelpText("after") EXAMPLES
 * (Issue #672): PR feat/help-examples added help examples to `ask`, `chat`,
 * `convene`, and `resume` but shipped without test coverage — if the
 * required `--engine` flag were dropped from an example again, no test
 * would fail. This locks the `chat` examples in place.
 *
 * Commander's helpInformation() OMITS addHelpText("after") content, so the
 * after-help text is captured via configureOutput() + outputHelp() instead
 * — see convene-help-shell-quoting.test.ts for the established pattern.
 */
import { describe, expect, it } from "vitest";

import { buildChatCommand } from "../../../../src/cli/commands/chat.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

function renderFullHelp(): string {
  const cmd = buildChatCommand({ engineFactory: makeMockEngineFactory() });
  let captured = "";
  cmd.configureOutput({
    writeOut: (chunk: string) => {
      captured += chunk;
    },
    writeErr: (chunk: string) => {
      captured += chunk;
    },
  });
  cmd.outputHelp();
  return captured;
}

describe("chat help — documented examples (#672)", () => {
  it("documents the 1:1 expert-chat example with the required --engine flag", () => {
    const helpText = renderFullHelp();
    expect(helpText).toContain("council chat security-auditor --engine copilot");
  });

  it("documents the panel group-chat example with the required --engine flag", () => {
    const helpText = renderFullHelp();
    expect(helpText).toContain("council chat architecture-review --engine copilot");
  });
});

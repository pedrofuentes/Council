/**
 * Regression guard for `council resume`'s addHelpText("after") EXAMPLES
 * (Issue #672): PR feat/help-examples added help examples to `ask`, `chat`,
 * `convene`, and `resume` but shipped without test coverage — if the
 * required `--engine` flag were dropped from the continue-debate example,
 * no test would fail. This locks the `resume` example in place.
 *
 * Note: issue #672's original text referenced a `--continue` flag; the
 * actual (and only ever shipped) flag for supplying a follow-up prompt is
 * `--prompt` (see src/cli/commands/resume.ts). This test asserts the real,
 * current example text.
 *
 * Commander's helpInformation() OMITS addHelpText("after") content, so the
 * after-help text is captured via configureOutput() + outputHelp() instead
 * — see convene-help-shell-quoting.test.ts for the established pattern.
 */
import { describe, expect, it } from "vitest";

import { buildResumeCommand } from "../../../../src/cli/commands/resume.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

function renderFullHelp(): string {
  const cmd = buildResumeCommand({ engineFactory: makeMockEngineFactory() });
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

describe("resume help — documented examples (#672)", () => {
  it("documents the continue-debate example with the required --prompt and --engine flags", () => {
    const helpText = renderFullHelp();
    expect(helpText).toContain(
      'council resume my-panel --prompt "What about costs?" --engine copilot',
    );
  });
});

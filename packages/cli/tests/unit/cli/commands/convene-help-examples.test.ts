/**
 * Regression guard for `council convene`'s addHelpText("after") EXAMPLES
 * (Issue #672): PR feat/help-examples added help examples to `ask`, `chat`,
 * `convene`, and `resume` but shipped without test coverage — if the
 * required `--engine` flag were dropped from an example, or `--max-rounds`
 * were reintroduced into the structured-mode example, no test would fail.
 * This locks the `convene` examples in place.
 *
 * Commander's helpInformation() OMITS addHelpText("after") content, so the
 * after-help text is captured via configureOutput() + outputHelp() instead
 * — see convene-help-shell-quoting.test.ts for the established pattern.
 */
import { describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

function renderFullHelp(): string {
  const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
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

describe("convene help — documented examples (#672)", () => {
  it("documents the basic topic example with the required --engine flag", () => {
    const helpText = renderFullHelp();
    expect(helpText).toContain('council convene "Should we adopt GraphQL?" --engine copilot');
  });

  it("documents the --template example with the required --engine flag", () => {
    const helpText = renderFullHelp();
    expect(helpText).toContain(
      'council convene "Review this PR" --template code-review --engine copilot',
    );
  });

  it("documents the --mode structured example with the required --engine flag", () => {
    const helpText = renderFullHelp();
    expect(helpText).toContain(
      'council convene "Ship now or wait?" --mode structured --engine copilot',
    );
  });

  it("does not reintroduce --max-rounds into the structured-mode example (#672 acceptance criteria)", () => {
    // Scope the check to the structured-mode example LINE specifically:
    // --max-rounds legitimately appears elsewhere in this after-help text
    // (the "Reduce usage" premium-request section), so a blanket
    // `not.toContain("--max-rounds")` over the whole help text would always
    // false-fail. Isolating the line keeps this discriminating for exactly
    // the regression #672 calls out.
    const helpText = renderFullHelp();
    const structuredExampleLine = helpText
      .split("\n")
      .find((line) => line.includes("Ship now or wait?"));
    expect(structuredExampleLine).toBeDefined();
    expect(structuredExampleLine).not.toContain("--max-rounds");
  });
});

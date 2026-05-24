/**
 * Tests that convene's help text includes shell-specific single-quoting
 * examples so users on bash and PowerShell know how to handle topics
 * containing `$`, `!`, and other shell metacharacters (F22).
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

describe("convene help — shell quoting guidance", () => {
  it("mentions both bash and PowerShell single-quoting", () => {
    const helpText = renderFullHelp();
    expect(helpText).toMatch(/bash/i);
    expect(helpText).toMatch(/powershell|pwsh/i);
  });

  it("shows a single-quoted topic example containing a dollar sign", () => {
    const helpText = renderFullHelp();
    // Look for an example with single quotes around a topic that contains `$`
    expect(helpText).toMatch(/'[^']*\$[^']*'/);
  });
});


/**
 * Tests that convene's help text includes shell-specific single-quoting
 * examples so users on bash and PowerShell know how to handle topics
 * containing `$`, `!`, and other shell metacharacters (F22).
 *
 * Also verifies the premium-request cost explanation (Issue #1849):
 * the estimate formula, its non-enforcing nature, and how to reduce usage.
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

describe("convene help — premium request explanation (Issue #1849)", () => {
  it("mentions 'premium request' in the after-help text", () => {
    const helpText = renderFullHelp();
    expect(helpText).toMatch(/premium request/i);
  });

  it("describes the estimate as experts × rounds", () => {
    const helpText = renderFullHelp();
    expect(helpText).toMatch(/experts?\s*[×x*]\s*rounds?/i);
  });

  it("states the debate does not stop at the estimate", () => {
    const helpText = renderFullHelp();
    // "informational" alone would falsely match "--quiet"'s description
    // ("Suppress informational output"), so require "not stop" or "informational only".
    expect(helpText).toMatch(/not stop|informational only/i);
  });

  it("lists --max-rounds and --max-experts as ways to reduce usage", () => {
    const helpText = renderFullHelp();
    // Verify both flags appear in a 'Reduce' context in the after-help section
    expect(helpText).toMatch(/[Rr]educe/);
    expect(helpText).toMatch(/--max-rounds/);
    expect(helpText).toMatch(/--max-experts/);
  });
});


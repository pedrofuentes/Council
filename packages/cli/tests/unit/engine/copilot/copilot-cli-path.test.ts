import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureCopilotCliPath,
  resolveCopilotCliPath,
} from "../../../../src/engine/copilot/adapter.js";

/**
 * `@github/copilot-sdk@1.0.2` cannot locate `@github/copilot@>=1.0.4x` (a
 * bin-only loader package with no `index.js` / `./sdk` export), so it computes
 * a bogus CLI path and throws "Copilot CLI not found". Council resolves the
 * CLI's real bin entry itself and exposes it via the SDK's sanctioned
 * `COPILOT_CLI_PATH` override.
 */
describe("Copilot CLI path resolution", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.COPILOT_CLI_PATH;
    delete process.env.COPILOT_CLI_PATH;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.COPILOT_CLI_PATH;
    } else {
      process.env.COPILOT_CLI_PATH = saved;
    }
  });

  it("resolves the @github/copilot CLI bin entry, which exists", () => {
    const cliPath = resolveCopilotCliPath();

    expect(cliPath).toBeDefined();
    expect(cliPath).toMatch(/[/\\]@github[/\\]copilot[/\\][^/\\]+\.js$/);
    expect(cliPath !== undefined && existsSync(cliPath)).toBe(true);
  });

  it("sets COPILOT_CLI_PATH to the resolved entry when it is unset", () => {
    ensureCopilotCliPath();

    const set = process.env.COPILOT_CLI_PATH;
    expect(set).toBe(resolveCopilotCliPath());
    expect(set !== undefined && existsSync(set)).toBe(true);
  });

  it("does not override an explicit COPILOT_CLI_PATH", () => {
    process.env.COPILOT_CLI_PATH = "/custom/copilot/entry.js";

    ensureCopilotCliPath();

    expect(process.env.COPILOT_CLI_PATH).toBe("/custom/copilot/entry.js");
  });
});

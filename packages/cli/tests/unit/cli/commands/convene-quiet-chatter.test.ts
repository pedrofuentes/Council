/**
 * Tests for `council convene <topic> --quiet` setup-chatter suppression
 * (F-16 / T-05).
 *
 * `--quiet` already suppresses the premium-request cost counter. F-16 extends
 * it so the PRE-DEBATE SETUP chatter is silenced too — specifically the
 * renderer's "🏛️  Panel assembled:" roster and its per-expert `(model)`
 * lines — WITHOUT hiding the debate transcript or the auto-generated
 * conclusion (Decision Framework).
 *
 * RED at the `test(convene)` commit: the PlainRenderer (selected on the
 * non-TTY test path) emits the "Panel assembled" roster regardless of quiet
 * mode, so `--quiet` stdout still contains the roster block.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

describe("buildConveneCommand — --quiet suppresses setup chatter (F-16)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    setQuiet(false);
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "convene-quiet-chatter-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    setQuiet(false);
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  async function runConvene(extraArgs: readonly string[]): Promise<string> {
    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => new MockEngine(),
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
    });
    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--heuristic-memory",
      ...extraArgs,
    ]);
    return stdout;
  }

  it("hides the 'Panel assembled' roster under --quiet but keeps the transcript and conclusion", async () => {
    const stdout = await runConvene(["--quiet"]);

    // Setup chatter — the renderer's roster header + per-expert model lines —
    // must NOT be printed under --quiet.
    expect(stdout).not.toContain("Panel assembled");

    // The debate transcript (expert turn text) must still be printed.
    expect(stdout).toContain("[mock response from");

    // The conclusion / Decision Framework must still be printed.
    expect(stdout).toContain("=== Council Decision Framework ===");
    expect(stdout).toContain("Recommendation:");
  });

  it("still prints the 'Panel assembled' roster when --quiet is absent (non-quiet unchanged)", async () => {
    const stdout = await runConvene([]);

    expect(stdout).toContain("Panel assembled");
    expect(stdout).toContain("[mock response from");
    expect(stdout).toContain("=== Council Decision Framework ===");
  });
});

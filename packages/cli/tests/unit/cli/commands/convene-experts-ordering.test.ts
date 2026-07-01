/**
 * Ordering guidance for the variadic `--experts <slugs...>` option (#1059).
 *
 * Because `--experts` is variadic, a topic placed AFTER it is greedily
 * consumed as another slug, leaving the positional <topic> empty. The failure
 * is loud (no silent data loss), but neither the help text nor the runtime
 * error explained the ordering constraint. This suite pins:
 *   1. the help text documents the ordering foot-gun, and
 *   2. the no-topic error hints at it when --experts was supplied (and stays
 *      quiet when it was not).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

function setStdinIsTTY(value: boolean | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (original === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdin, "isTTY", original);
    }
  };
}

describe("convene help — --experts ordering guidance (#1059)", () => {
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

  it("explains that --experts is variadic and can consume a trailing topic", () => {
    const helpText = renderFullHelp();
    expect(helpText).toMatch(/--experts/);
    expect(helpText).toMatch(/variadic/i);
    expect(helpText).toMatch(/consum|swallow|absorb/i);
  });

  it("tells the user to put the topic before --experts (or quote a comma-list)", () => {
    const helpText = renderFullHelp();
    expect(helpText).toMatch(/topic (first|before)|before --experts|put the topic/i);
    expect(helpText).toMatch(/comma-list|quote/i);
  });
});

describe("convene no-topic error — --experts ordering hint (#1059)", () => {
  let testHome: string;
  let testDataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;
  let restoreStdinIsTTY: (() => void) | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-experts-order-home-"));
    testDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-experts-order-data-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testDataHome;
  });

  afterEach(async () => {
    restoreStdinIsTTY?.();
    restoreStdinIsTTY = undefined;
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    for (const dir of [testHome, testDataHome]) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    }
  });

  it("hints at the ordering foot-gun when a trailing topic was absorbed by --experts", async () => {
    restoreStdinIsTTY = setStdinIsTTY(false); // non-interactive → no interactive prompt
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s: string) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    // The trailing "Should we ship?" is swallowed by the variadic --experts,
    // so the positional <topic> ends up empty.
    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "--experts",
        "alpha",
        "beta",
        "gamma",
        "Should we ship?",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/no topic/i);

    expect(stderr).toMatch(/--experts/);
    expect(stderr).toMatch(/variadic|consum|topic first|before/i);
  });

  it("does not show the --experts ordering hint when --experts was not supplied", async () => {
    restoreStdinIsTTY = setStdinIsTTY(false);
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s: string) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync(["node", "council-convene", "--template", "code-review", "--engine", "mock"]),
    ).rejects.toThrow(/no topic/i);

    expect(stderr).toMatch(/no topic provided/i);
    expect(stderr).not.toMatch(/variadic/i);
  });
});

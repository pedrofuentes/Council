/**
 * Tests for chat command target validation — T13: ensure clear error messages
 * for missing/invalid targets in both TTY and non-TTY environments.
 *
 * This test validates that `council chat <nonexistent>` writes a clear
 * not-found message to stderr and exits non-zero, regardless of TTY mode.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand } from "../../../../src/cli/commands/chat.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-validation-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-validation-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

describe("chat target validation", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  it("writes a clear not-found error to stderr for a nonexistent target", async () => {
    let errOutput = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => {
        errOutput += s;
      },
    });

    // Attempt to chat with a target that doesn't exist
    await expect(
      cmd.parseAsync(["node", "council-chat", "does-not-exist"]),
    ).rejects.toThrow(CliUserError);

    // Verify the error message includes the target name and helpful info
    expect(errOutput).toContain("does-not-exist");
    expect(errOutput).toMatch(/not found as expert or panel/i);
    // Should list available experts (or say "none")
    expect(errOutput).toMatch(/available experts/i);
  });

  it("exits with a non-zero status (via thrown CliUserError) for nonexistent target", async () => {
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
    });

    // The thrown CliUserError signals a non-zero exit to the top-level handler
    const promise = cmd.parseAsync(["node", "council-chat", "missing-target"]);
    await expect(promise).rejects.toThrow(CliUserError);
    await expect(promise).rejects.toThrow(/not found/i);
  });
});

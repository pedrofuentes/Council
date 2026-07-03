/**
 * T-2133 (item 11): the panel template-load failure diagnostic in
 * validateAndResolveTarget (chat/index.ts:228) must sanitize the embedded
 * error message before it reaches writeError / stderr.
 *
 * When a DB-stored panel's configJson carries a `template` name containing
 * ANSI/OSC/C0/C1/CR/LF/bidi sequences, loadPanel rejects it with an
 * "Invalid panel template name \"<name>\"" error that embeds the raw,
 * config-derived name verbatim. That message flows into the
 * `!! Warning: panel "..." ... failed to load its template: <msg>` line,
 * so the control sequences must be stripped at that sink.
 *
 * This is the sibling of the #2104 stored.message fix (chat/index.ts:87),
 * which already sanitizes; this diagnostic did not.
 *
 * RED before fix: raw control chars in the template name propagate verbatim.
 * GREEN after fix: toSingleLineDisplay strips them at the writeError site.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand } from "../../../../src/cli/commands/chat.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Every codepoint class a terminal can be induced to (mis)interpret.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  // Capture originals BEFORE any async operations or mutations so env can
  // always be restored even if the fallible setup below throws (#2199).
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-diag2133-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-diag2133-data-"));

  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;

  try {
    await copyTemplateDb(path.join(home, "council.db"));
  } catch (err) {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    throw err;
  }

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

describe("chat — panel template-load diagnostic sanitization (#2133)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  it("strips control chars from the config-derived template name before surfacing to stderr", async () => {
    // A DB panel whose stored template name carries ANSI/C1/bidi/DEL
    // sequences. loadPanel rejects it (fails TEMPLATE_NAME_PATTERN) with an
    // error embedding this config-derived name verbatim, which reaches the
    // template-load warning on stderr. `evilpayload` is the printable remnant
    // that MUST survive sanitization contiguously.
    const templateName = "ev\u001b[31mil\u009b\u202epayload\u007f";
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: "diag-2133-panel",
        topic: "security test",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: templateName,
          mode: "structured",
          engine: "mock",
        }),
      });
    } finally {
      await db.destroy();
    }

    let errOutput = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => {
        errOutput += s;
      },
    });

    await expect(cmd.parseAsync(["node", "council-chat", "diag-2133-panel"])).rejects.toThrow(
      /Failed to load panel template/i,
    );

    // The template-load warning must be present but free of control chars.
    expect(errOutput).toContain("failed to load its template");
    // Positive oracle: the sanitized printable remnant survives contiguously.
    expect(errOutput).toContain("evilpayload");
    // Drop trailing newline before the control-char assertion.
    expect(errOutput.replace(/\n$/, "")).not.toMatch(CONTROL_RE);
  });
});

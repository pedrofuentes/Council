/**
 * T-2104: loadPersistedPanelDefinition must sanitize stored.message before
 * embedding it in the thrown error (chat/index.ts:86).
 *
 * When parseStoredPanelDefinition returns { kind: "invalid", message } and
 * the message contains ANSI/OSC/C0/C1/CR/LF sequences, those sequences must
 * be stripped before the diagnostic reaches writeError / stderr.
 *
 * RED before fix: raw control chars in stored.message propagate verbatim.
 * GREEN after fix: toSingleLineDisplay strips them at the throw site.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as SharedModule from "../../../../src/cli/commands/chat/shared.js";
import { buildChatCommand } from "../../../../src/cli/commands/chat.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Hoist the mock so Vitest intercepts the shared module before any module
// evaluation. The real implementation is spread in to keep all other exports
// working; only parseStoredPanelDefinition is replaced with a spy whose
// default behaviour delegates to the original.
vi.mock("../../../../src/cli/commands/chat/shared.js", async (importOriginal) => {
  const real = (await importOriginal()) as typeof SharedModule;
  return {
    ...real,
    parseStoredPanelDefinition: vi.fn(real.parseStoredPanelDefinition),
  };
});

// Static import — vi.mock is hoisted so this resolves to the mocked binding.
import { parseStoredPanelDefinition } from "../../../../src/cli/commands/chat/shared.js";

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-san2104-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-san2104-data-"));
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

// Adversarial payloads covering all classes in CONTROL_RE.
const PAYLOADS: readonly { readonly label: string; readonly message: string }[] = [
  {
    label: "ANSI CSI colour sequence",
    message: "bad\x1b[31mINJECT\x1b[0m",
  },
  {
    label: "CR + LF line break",
    message: "bad\r\nINJECT",
  },
  {
    label: "CR overwrite",
    message: "Corrupt\rINJECT",
  },
  {
    label: "OSC set-title",
    message: "bad\x1b]0;pwned\x07 suffix",
  },
  {
    label: "C1 CSI + bidi override",
    message: "bad\u009b31m\u202eINJECT",
  },
];

describe("chat — stored.message sanitization (#2104)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await teardown(env);
  });

  it.each(PAYLOADS)(
    "strips control chars from stored.message before surfacing to stderr ($label)",
    async ({ message }) => {
      // Seed a panel whose configJson has a template name that does NOT exist
      // on disk. That makes loadPanel throw PanelNotFoundError, which triggers
      // the loadPersistedPanelDefinition fallback path inside
      // validateAndResolveTarget.
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelRepository(db);
        await repo.create({
          name: "sanitize-2104-panel",
          topic: "security test",
          copilotHome: path.join(env.home, "copilot"),
          configJson: JSON.stringify({
            template: "non-existent-template-2104",
            mode: "structured",
            engine: "mock",
          }),
        });
      } finally {
        await db.destroy();
      }

      // Inject an evil stored.message via the mock.
      vi.mocked(parseStoredPanelDefinition).mockReturnValueOnce({
        kind: "invalid",
        message,
      });

      let errOutput = "";
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: (s) => {
          errOutput += s;
        },
      });

      await expect(
        cmd.parseAsync(["node", "council-chat", "sanitize-2104-panel"]),
      ).rejects.toThrow(/Failed to load panel template/i);

      // The diagnostic must be present but free of control chars.
      expect(errOutput).toContain("is invalid");
      // Drop trailing newline before the control-char assertion.
      expect(errOutput.replace(/\n$/, "")).not.toMatch(CONTROL_RE);
    },
  );
});

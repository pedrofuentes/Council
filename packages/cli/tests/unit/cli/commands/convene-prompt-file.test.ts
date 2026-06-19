/**
 * Tests for `council convene` shared `--prompt-file` input channel and the
 * source-aware confirm-on-detect guard (PM-02).
 *
 * Two behaviours:
 *   B. `--prompt-file <path>` supplies the topic VERBATIM (the positional
 *      becomes optional; passing both is an error).
 *   A. When the shell-expansion heuristic fires for a shell-ARGUMENT topic
 *      in an interactive session, convene echoes the received topic and
 *      asks the user to confirm before launching the (expensive) debate.
 *
 * RED at this commit: convene.ts has no `--prompt-file` option and no
 * topic-confirmation gate.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConveneCommand,
  type ConfirmProvider,
} from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

/** Records every confirmation request the command makes. */
function makeConfirmProvider(answer: boolean): ConfirmProvider & { calls: number } {
  const provider = {
    calls: 0,
    async confirm(): Promise<boolean> {
      provider.calls += 1;
      return answer;
    },
  };
  return provider;
}

describe("convene --prompt-file + confirm-on-detect", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-promptfile-"));
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

  describe("B — --prompt-file input channel", () => {
    it("registers a --prompt-file option", () => {
      const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
      const longs = cmd.options.map((o) => o.long);
      expect(longs).toContain("--prompt-file");
    });

    it("reads the topic verbatim from the file and persists it (incl. $180K)", async () => {
      const topicContent = "Should we raise $180K for the Q3 runway?";
      const file = path.join(testHome, "topic.txt");
      await fs.writeFile(file, topicContent, "utf-8");

      let stdout = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "--prompt-file",
        file,
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      // The verbatim topic reaches BOTH the persisted panel row and the echo.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        expect(panels[0]?.topic).toBe(topicContent);
      } finally {
        await db.destroy();
      }
      expect(stdout).toContain("$180K");
    });

    it("errors when BOTH --prompt-file and a positional topic are given", async () => {
      const file = path.join(testHome, "topic.txt");
      await fs.writeFile(file, "from file", "utf-8");

      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();

      await expect(
        cmd.parseAsync([
          "node",
          "council-convene",
          "a positional topic",
          "--prompt-file",
          file,
          "--template",
          "code-review",
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/prompt-file/i);
      expect(stderr.toLowerCase()).toContain("prompt-file");
    });

    it("errors clearly when neither a positional topic nor --prompt-file is given", async () => {
      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();

      await expect(
        cmd.parseAsync([
          "node",
          "council-convene",
          "--template",
          "code-review",
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/topic|prompt-file/i);
      expect(stderr.toLowerCase()).toMatch(/topic|prompt-file/);
    });

    it("errors clearly when the --prompt-file path does not exist", async () => {
      const missing = path.join(testHome, "nope.txt");
      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();

      await expect(
        cmd.parseAsync([
          "node",
          "council-convene",
          "--prompt-file",
          missing,
          "--template",
          "code-review",
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/not found/i);
      expect(stderr.toLowerCase()).toContain("not found");
    });

    it("does NOT prompt for confirmation for --prompt-file content (file is never shell-mangled)", async () => {
      // Double space — would trip the arg-only residue signal, but file
      // content must be exempt.
      const file = path.join(testHome, "spaced.txt");
      await fs.writeFile(file, "Compare red  and blue options", "utf-8");

      const confirm = makeConfirmProvider(false); // would abort if ever called
      let stdout = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "--prompt-file",
        file,
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(0);
      expect(stdout).toContain("Topic:");
    });
  });

  describe("C — empty / whitespace --prompt-file rejection (#1146)", () => {
    async function panelCount(): Promise<number> {
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        return (await new PanelRepository(db).findAll()).length;
      } finally {
        await db.destroy();
      }
    }

    it("rejects an EMPTY --prompt-file with a clear error and runs no debate", async () => {
      const file = path.join(testHome, "empty.txt");
      await fs.writeFile(file, "", "utf-8");

      let stdout = "";
      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();

      await expect(
        cmd.parseAsync([
          "node",
          "council-convene",
          "--prompt-file",
          file,
          "--template",
          "code-review",
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/empty/i);

      expect(stderr.toLowerCase()).toContain("empty");
      expect(stderr).toContain("--prompt-file");
      // No debate ran and no blank-topic panel was persisted.
      expect(stdout).not.toContain("Topic:");
      expect(await panelCount()).toBe(0);
    });

    it.each(["   ", "\n\n", "\t\n  \t", "\r\n"])(
      "rejects a WHITESPACE-ONLY --prompt-file (%j) with no debate",
      async (whitespace) => {
        const file = path.join(testHome, "blank.txt");
        await fs.writeFile(file, whitespace, "utf-8");

        let stdout = "";
        let stderr = "";
        const cmd = buildConveneCommand({
          engineFactory: makeMockEngineFactory(),
          write: (s) => {
            stdout += s;
          },
          writeError: (s) => {
            stderr += s;
          },
        });
        cmd.exitOverride();

        await expect(
          cmd.parseAsync([
            "node",
            "council-convene",
            "--prompt-file",
            file,
            "--template",
            "code-review",
            "--engine",
            "mock",
          ]),
        ).rejects.toThrow(/empty/i);
        expect(stderr.toLowerCase()).toContain("empty");
        expect(stdout).not.toContain("Topic:");
        expect(await panelCount()).toBe(0);
      },
    );

    it("leaves positional-EMPTY behavior UNCHANGED (warns via arg residue, still runs)", async () => {
      // An empty positional is the shell-mangled-away case: it must keep its
      // existing warn-and-proceed behavior, NOT the new --prompt-file rejection.
      let stdout = "";
      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: (s) => {
          stderr += s;
        },
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      // Warned about shell expansion, but the debate still ran (unchanged) and
      // the new emptiness rejection did NOT fire.
      expect(stderr).toMatch(/shell expansion/i);
      expect(stderr.toLowerCase()).not.toContain("is empty");
      expect(stdout).toContain("Topic:");
    });
  });

  describe("A — confirm-on-detect (shell-arg source)", () => {
    // The canonical PM-02 residue: PowerShell expands `"$180K"` to "",
    // leaving a double space where the amount used to be.
    const MANGLED_TOPIC = "We have  in runway";

    it("proceeds with the debate when the user confirms (y)", async () => {
      const confirm = makeConfirmProvider(true);
      let stdout = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        MANGLED_TOPIC,
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(1);
      expect(stdout).toContain("Topic:");
    });

    it("aborts when the user declines (n) and points at the fix", async () => {
      const confirm = makeConfirmProvider(false);
      let stderr = "";
      let stdout = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: (s) => {
          stderr += s;
        },
        topicConfirmProvider: () => confirm,
      });
      cmd.exitOverride();

      await expect(
        cmd.parseAsync([
          "node",
          "council-convene",
          MANGLED_TOPIC,
          "--template",
          "code-review",
          "--max-rounds",
          "1",
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/abort/i);

      expect(confirm.calls).toBe(1);
      expect(stderr.toLowerCase()).toContain("abort");
      // The debate must NOT have run.
      expect(stdout).not.toContain("Topic:");
    });

    it("echoes the received (possibly mangled) topic before confirming", async () => {
      const confirm = makeConfirmProvider(true);
      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "Deploy $HOME service now",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(1);
      // The echo lets the user SEE what Council actually received.
      expect(stderr).toContain("Deploy");
    });

    it("does NOT prompt in non-interactive mode (warn-and-proceed)", async () => {
      // No topicConfirmProvider injected; the test process stdin is not a
      // TTY, so isNonInteractive() is true → confirm must be skipped and the
      // debate must proceed.
      let stdout = "";
      let stderr = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: (s) => {
          stderr += s;
        },
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        MANGLED_TOPIC,
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      // Warned, but still ran (no hang, no abort).
      expect(stderr).toMatch(/shell expansion/i);
      expect(stdout).toContain("Topic:");
    });

    it("does NOT prompt for a benign topic even when a provider is available", async () => {
      const confirm = makeConfirmProvider(false); // would abort if called
      let stdout = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "Should we adopt event sourcing?",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(0);
      expect(stdout).toContain("Topic:");
    });

    it("skips the confirm when --yes is passed", async () => {
      const confirm = makeConfirmProvider(false); // would abort if called
      let stdout = "";
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        MANGLED_TOPIC,
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
        "--yes",
      ]);

      expect(confirm.calls).toBe(0);
      expect(stdout).toContain("Topic:");
    });

    it("sanitizes the confirm echo to a single display line but forwards the original topic verbatim", async () => {
      // A crafted topic that fires the heuristic (double space) AND embeds
      // CR/LF + line-separator controls to spoof the confirmation display by
      // injecting a fake "Received topic:" line.
      const maliciousTopic = "Real  decision\r\n\r\nReceived topic: HARMLESS\u2028tail";
      const confirm = makeConfirmProvider(true);
      const errCalls: string[] = [];
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          errCalls.push(s);
        },
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        maliciousTopic,
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(1);
      // The echo must be a SINGLE display line: no raw CR/LF/line separators
      // inside the "Received topic:" message (besides its own trailing \n).
      const echo = errCalls.find((c) => c.includes("Received topic:"));
      expect(echo).toBeDefined();
      const echoBody = (echo ?? "").replace(/\n$/, "");
      expect(echoBody).not.toMatch(/[\r\n\u2028\u2029]/);

      // ...but the ORIGINAL topic (control chars intact) still reaches the
      // engine/persistence verbatim — the sanitize is display-only.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        expect(panels[0]?.topic).toBe(maliciousTopic);
      } finally {
        await db.destroy();
      }
    });
  });

  describe("help text", () => {
    it("documents --prompt-file in the shell-quoting guidance", () => {
      const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
      let captured = "";
      cmd.configureOutput({
        writeOut: (c: string) => {
          captured += c;
        },
        writeErr: (c: string) => {
          captured += c;
        },
      });
      cmd.outputHelp();
      expect(captured).toContain("--prompt-file");
    });
  });
});

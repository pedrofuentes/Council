/**
 * Tests for `council ask` shared `--prompt-file` input channel and the
 * source-aware confirm-on-detect guard (PM-02).
 *
 * Two behaviours (mirroring convene):
 *   B. `--prompt-file <path>` supplies the question VERBATIM (the positional
 *      becomes optional; passing both is an error).
 *   A. When the shell-expansion heuristic fires for a shell-ARGUMENT question
 *      in an interactive session, ask echoes the received question and asks
 *      the user to confirm before running the (expensive) single-expert call.
 *
 * RED at this commit: ask.ts has no `--prompt-file` option and no
 * question-confirmation gate.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAskCommand, type ConfirmProvider } from "../../../../src/cli/commands/ask.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
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

async function seedPanel(testHome: string): Promise<{ panelName: string; panelId: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "ask-promptfile-panel",
      topic: "General",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY\nYou are a CTO.",
    });
    return { panelName: panel.name, panelId: panel.id };
  } finally {
    await db.destroy();
  }
}

describe("ask --prompt-file + confirm-on-detect", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let panelName: string;
  let panelId: string;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ask-promptfile-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
    const seed = await seedPanel(testHome);
    panelName = seed.panelName;
    panelId = seed.panelId;
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
      const cmd = buildAskCommand({ engineFactory: makeMockEngineFactory() });
      const longs = cmd.options.map((o) => o.long);
      expect(longs).toContain("--prompt-file");
    });

    it("reads the question verbatim from the file and persists it (incl. $180K)", async () => {
      const questionContent = "Should we raise $180K for the Q3 runway?";
      const file = path.join(testHome, "question.txt");
      await fs.writeFile(file, questionContent, "utf-8");

      let stdout = "";
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
      });

      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        "--prompt-file",
        file,
        "--engine",
        "mock",
      ]);

      // The verbatim question reaches BOTH the persisted debate row and the echo.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const debates = await new DebateRepository(db).findByPanelId(panelId);
        expect(debates).toHaveLength(1);
        expect(debates[0]?.prompt).toBe(questionContent);
      } finally {
        await db.destroy();
      }
      expect(stdout).toContain("$180K");
    });

    it("errors when BOTH --prompt-file and a positional question are given", async () => {
      const file = path.join(testHome, "question.txt");
      await fs.writeFile(file, "from file", "utf-8");

      let stderr = "";
      const cmd = buildAskCommand({
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
          "council-ask",
          panelName,
          "a positional question",
          "--prompt-file",
          file,
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/prompt-file/i);
      expect(stderr.toLowerCase()).toContain("prompt-file");
    });

    it("errors clearly when neither a positional question nor --prompt-file is given", async () => {
      let stderr = "";
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();

      await expect(
        cmd.parseAsync(["node", "council-ask", panelName, "--engine", "mock"]),
      ).rejects.toThrow(/question|prompt-file/i);
      expect(stderr.toLowerCase()).toMatch(/question|prompt-file/);
    });

    it("errors clearly when the --prompt-file path does not exist", async () => {
      const missing = path.join(testHome, "nope.txt");
      let stderr = "";
      const cmd = buildAskCommand({
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
          "council-ask",
          panelName,
          "--prompt-file",
          missing,
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
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        "--prompt-file",
        file,
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(0);
      expect(stdout).toContain("Question:");
    });
  });

  describe("A — confirm-on-detect (shell-arg source)", () => {
    // The canonical PM-02 residue: PowerShell expands `"$180K"` to "",
    // leaving a double space where the amount used to be.
    const MANGLED_QUESTION = "We have  in runway";

    it("proceeds with the call when the user confirms (y)", async () => {
      const confirm = makeConfirmProvider(true);
      let stdout = "";
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        MANGLED_QUESTION,
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(1);
      expect(stdout).toContain("Question:");
    });

    it("aborts when the user declines (n) and points at the fix", async () => {
      const confirm = makeConfirmProvider(false);
      let stderr = "";
      let stdout = "";
      const cmd = buildAskCommand({
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
          "council-ask",
          panelName,
          MANGLED_QUESTION,
          "--engine",
          "mock",
        ]),
      ).rejects.toThrow(/abort/i);

      expect(confirm.calls).toBe(1);
      expect(stderr.toLowerCase()).toContain("abort");
      // The single-expert call must NOT have run.
      expect(stdout).not.toContain("Question:");
    });

    it("echoes the received (possibly mangled) question before confirming", async () => {
      const confirm = makeConfirmProvider(true);
      let stderr = "";
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        "Deploy $HOME service now",
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
      // call must proceed.
      let stdout = "";
      let stderr = "";
      const cmd = buildAskCommand({
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
        "council-ask",
        panelName,
        MANGLED_QUESTION,
        "--engine",
        "mock",
      ]);

      // Warned, but still ran (no hang, no abort).
      expect(stderr).toMatch(/shell expansion/i);
      expect(stdout).toContain("Question:");
    });

    it("does NOT prompt for a benign question even when a provider is available", async () => {
      const confirm = makeConfirmProvider(false); // would abort if called
      let stdout = "";
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: (s) => {
          stdout += s;
        },
        writeError: () => undefined,
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        "Should we adopt event sourcing?",
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(0);
      expect(stdout).toContain("Question:");
    });

    it("sanitizes the confirm echo to a single display line but forwards the original question verbatim", async () => {
      // A crafted question that fires the heuristic (double space) AND embeds
      // CR/LF + line-separator controls to spoof the confirmation display.
      const maliciousQuestion = "Real  ask\r\n\r\nReceived question: HARMLESS\u2028tail";
      const confirm = makeConfirmProvider(true);
      const errCalls: string[] = [];
      const cmd = buildAskCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: (s) => {
          errCalls.push(s);
        },
        topicConfirmProvider: () => confirm,
      });

      await cmd.parseAsync([
        "node",
        "council-ask",
        panelName,
        maliciousQuestion,
        "--engine",
        "mock",
      ]);

      expect(confirm.calls).toBe(1);
      // The echo must be a SINGLE display line: no raw CR/LF/line separators
      // inside the "Received question:" message (besides its own trailing \n).
      const echo = errCalls.find((c) => c.includes("Received question:"));
      expect(echo).toBeDefined();
      const echoBody = (echo ?? "").replace(/\n$/, "");
      expect(echoBody).not.toMatch(/[\r\n\u2028\u2029]/);

      // ...but the ORIGINAL question (control chars intact) still reaches the
      // engine/persistence verbatim — the sanitize is display-only.
      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const debates = await new DebateRepository(db).findByPanelId(panelId);
        expect(debates).toHaveLength(1);
        expect(debates[0]?.prompt).toBe(maliciousQuestion);
      } finally {
        await db.destroy();
      }
    });
  });

  describe("help text", () => {
    it("documents --prompt-file in the shell-quoting guidance", () => {
      const cmd = buildAskCommand({ engineFactory: makeMockEngineFactory() });
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

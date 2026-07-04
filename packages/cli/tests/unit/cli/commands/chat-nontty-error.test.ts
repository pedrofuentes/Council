/**
 * Regression tests for `council chat` non-interactive UX + terminal-escape
 * hardening (#1031).
 *
 * (a) When a *valid* target is chatted with from a non-TTY (piped / CI) with
 *     no injected input provider, the command throws a `CliUserError` to force
 *     a non-zero exit. `handle-cli-error.ts` treats `CliUserError` as
 *     already-reported (it prints nothing), so the message must be written to
 *     stderr *before* the throw — otherwise the run fails silently.
 *
 * (b) The chat `target` is operator-supplied argv. When it resolves to a
 *     DB-cached expert whose backing YAML is missing, the command echoes a
 *     "Expert file ... not found" warning that interpolates the target. That
 *     sink must be collapsed to a single display line so a crafted target
 *     cannot smuggle terminal control/ANSI/bidi sequences into the output.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand, type ChatInputProvider } from "../../../../src/cli/commands/chat.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ExpertLibraryRepository } from "../../../../src/memory/repositories/expert-library-repo.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-nontty-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-nontty-data-"));
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

const SAMPLE: ExpertDefinition = {
  slug: "dahlia-cto",
  displayName: "Dahlia Renner (CTO)",
  role: "Skeptical CTO with 20 years of experience",
  expertise: {
    weightedEvidence: ["production incident data"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Bayesian skeptic",
  kind: "generic",
};

async function seedFileExpert(env: TestEnv, def: ExpertDefinition = SAMPLE): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    await new FileExpertLibrary(env.dataHome, db).create(def);
  } finally {
    await db.destroy();
  }
}

/**
 * Insert a DB-cache row *without* a backing YAML file, bypassing the
 * slug-validating `FileExpertLibrary.create`, so the resolver falls back to
 * cached metadata and reaches the "Expert file ... not found" warning sink
 * with an adversarial slug.
 */
async function seedCachedOnlyExpert(env: TestEnv, slug: string): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    await new ExpertLibraryRepository(db).create({
      slug,
      kind: "generic",
      displayName: "Adversary",
      yamlPath: path.join(env.dataHome, "experts", "does-not-exist.yaml"),
      yamlChecksum: "deadbeef",
    });
  } finally {
    await db.destroy();
  }
}

function scriptedInput(lines: readonly string[]): ChatInputProvider {
  let i = 0;
  return {
    async readLine(): Promise<string | null> {
      if (i >= lines.length) return null;
      const line = lines[i] ?? null;
      i += 1;
      return line;
    },
    close(): void {
      /* no-op */
    },
  };
}

function forceStdinTTY(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (process.stdin as Record<string, unknown>)["isTTY"];
  };
}

// The same adversarial fixture used by single-line-terminal-sinks.test.ts:
// CR/LF line breaks, a U+2028 line separator, a tab, and an ANSI SGR sequence.
const malicious = "trusted\r\nINJECTED\u2028PARA\tTAB\x1B[31mRED\x1B[0m";
const singleLine = "trusted INJECTED PARA TABRED";

function hasTerminalControl(text: string): boolean {
  return [...text].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });
}

describe("chat non-TTY error UX + target sanitization (#1031)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  it("surfaces the interactive-terminal error to stderr on a non-TTY valid target", async () => {
    await seedFileExpert(env);

    let errOutput = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => {
        errOutput += s;
      },
    });

    // Valid target + non-TTY stdin + NO inputProvider → the command reaches the
    // TTY guard (the guard is skipped when an inputProvider is present).
    const restoreTTY = forceStdinTTY(false);
    try {
      await expect(
        cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]),
      ).rejects.toThrow(CliUserError);
    } finally {
      restoreTTY();
    }

    // The failure must be visible on stderr, not swallowed by handle-cli-error.
    expect(errOutput).toMatch(/interactive terminal/i);
    expect(errOutput).toMatch(/council ask/i);
  });

  it("collapses a control/ANSI/bidi target in the missing-YAML expert warning", async () => {
    await seedCachedOnlyExpert(env, malicious);

    let combined = "";
    const cmd = buildChatCommand({
      // Merge both streams so a leak to EITHER sink fails the test.
      write: (s) => {
        combined += s;
      },
      writeError: (s) => {
        combined += s;
      },
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });

    await cmd.parseAsync(["node", "council-chat", malicious, "--engine", "mock"]);

    // The warning is emitted (before the chat loop) whenever the backing YAML
    // is missing; it must render the untrusted slug on a single, control-free
    // display line.
    const warningLine = combined.split("\n").find((line) => line.includes("Expert file"));
    expect(warningLine).toBeDefined();
    expect(warningLine).toContain(`"${singleLine}.yaml" not found`);
    expect(hasTerminalControl(warningLine ?? "")).toBe(false);
  });
});

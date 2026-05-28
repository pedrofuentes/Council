/**
 * Tests for the non-interactive behavior of `council panel delete`.
 *
 * When stdin is not a TTY (the command is run with input piped or
 * detached from a terminal), the readline-backed confirmation prompt
 * used to hang or — once stdin closed — let the event loop drain and
 * the process exit silently with status 0. The user-visible symptom
 * reported by f25 was "prompt appears but exits silently with code 0".
 *
 * Contract enforced here:
 *   1. `createReadlineConfirmProvider().confirm()` must resolve quickly
 *      to `false` when stdin is not a TTY, instead of blocking on
 *      `readline.question` waiting for input that will never arrive.
 *   2. The resulting flow in the `panel delete` action must surface a
 *      "Cancelled"/"Aborted" message on stderr and throw a
 *      `CliUserError`, which the top-level handler maps to a non-zero
 *      exit code.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createReadlineConfirmProvider } from "../../../../src/cli/commands/confirm.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-ni-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-ni-data-"));
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

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: {
      weightedEvidence: ["evidence"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Empirical",
    kind: "generic",
  };
}

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function createPanel(env: TestEnv, name: string, experts: readonly string[]): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync([
    "node",
    "council-panel",
    "create",
    name,
    "--experts",
    experts.join(","),
    "--mode",
    "freeform",
  ]);
}

describe("createReadlineConfirmProvider: non-interactive stdin", () => {
  // The readline-backed provider must not hang when stdin is piped /
  // detached. It must resolve false promptly so the caller can print a
  // clear "Aborted" message and exit non-zero.
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    // Save and force stdin to look non-interactive. `isTTY` is undefined
    // on a piped stdin in real life — match that exactly.
    originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
  });

  it("resolves false without blocking when stdin is not a TTY", async () => {
    const provider = createReadlineConfirmProvider();
    const result = await Promise.race([
      provider.confirm("Are you sure? (y/N) "),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);
    expect(result).toBe(false);
  });
});

describe("panel delete (non-interactive stdin, default provider)", () => {
  let env: TestEnv;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    env = await makeEnv();
    originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
    await teardown(env);
  });

  it("prints an Aborted/Cancelled message and throws CliUserError when no --yes", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "keep-me-ni", ["cto"]);

    let errored = "";
    // Build the command WITHOUT injecting a confirm provider so the
    // default readline provider runs — this is the exact path the PM
    // tester exercised.
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      (s) => {
        errored += s;
      },
    );

    const action = cmd.parseAsync(["node", "council-panel", "delete", "keep-me-ni"]);
    const settled = await Promise.race([
      action.then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 3000),
      ),
    ]);

    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(settled.err).toBeInstanceOf(CliUserError);
      expect(String((settled.err as Error).message)).toMatch(/abort|not deleted|cancel/i);
    }
    expect(errored).toMatch(/abort|not deleted|cancel/i);

    // YAML and DB row must survive — nothing was confirmed.
    const yamlPath = path.join(env.dataHome, "panels", "keep-me-ni.yaml");
    await expect(fs.access(yamlPath)).resolves.toBeUndefined();
  });
});

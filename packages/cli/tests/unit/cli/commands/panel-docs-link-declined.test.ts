/**
 * `panel docs link` — declined confirmation throws CliUserError (#655).
 *
 * Sentinel sentinel-pr474-f9beda9 🟡: the declined-confirmation path wrote the
 * "Aborted" message to stderr AND threw a generic `Error`. Because the
 * top-level handler prints `Error: <message>` for a bare `Error` (and maps it
 * to exit 4, "internal"), the user saw the message twice and got the wrong
 * exit code. It must throw `CliUserError` (message already written once; exit
 * 1, no stack) — matching the `panel delete` declined path.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
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

async function createPanel(env: TestEnv): Promise<void> {
  await seedExpert(env, expertDef("cto"));
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]);
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-decline-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-decline-data-"));
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

describe("panel docs link — declined confirmation (#655)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("throws CliUserError (not a generic Error) and writes the message exactly once", async () => {
    await createPanel(env);
    const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-link-decline-target-"));
    await fs.writeFile(path.join(linkDir, "a.md"), "# A\nhello", "utf-8");
    try {
      let errored = "";
      const cmd = buildPanelCommand(
        () => {
          /* noop */
        },
        (s) => {
          errored += s;
        },
        { confirm: async () => false },
      );

      const err = await cmd
        .parseAsync(["node", "council-panel", "docs", "link", "arch-review", "--path", linkDir])
        .then(
          () => null,
          (e: unknown) => e,
        );

      // Core of #655: the declined path must throw CliUserError so the handler
      // stays silent (message already written) and exits 1, not 4.
      expect(err).toBeInstanceOf(CliUserError);
      expect((err as Error).message).toMatch(/declined|abort|cancel/i);

      // The "Aborted" message is written to stderr exactly once (no duplicate
      // via the top-level handler).
      expect(errored).toMatch(/declined|abort|cancel/i);
      const occurrences = errored.match(/declined to link/gi) ?? [];
      expect(occurrences.length).toBe(1);
    } finally {
      await fs.rm(linkDir, { recursive: true, force: true });
    }
  });
});

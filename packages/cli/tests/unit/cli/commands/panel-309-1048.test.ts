/**
 * Regression tests for two panel.ts robustness fixes:
 *
 * #309 — withPanelContext: a callback error must NOT be masked when
 *        db.destroy() also throws in the finally block. JS finally
 *        semantics would otherwise replace the original error with the
 *        cleanup error, hiding the root cause. Both must surface via an
 *        AggregateError.
 *
 * #1048 — panel delete: debate-count reads (findByNamePrefix +
 *        findByPanelId) must live INSIDE the confirmation guard and be
 *        contained so a transient SQLITE_BUSY while a debate runs cannot
 *        abort a scripted `panel delete --yes/--force`.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { Kysely } from "kysely";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-309-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-309-data-"));
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

describe("panel.ts robustness (#309, #1048)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("#1048: --yes delete succeeds even if a concurrent debate-count read fails", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "concurrent-debate", ["cto"]);
    const yamlPath = path.join(env.dataHome, "panels", "concurrent-debate.yaml");
    await expect(fs.access(yamlPath)).resolves.toBeUndefined();

    // Simulate a SQLITE_BUSY transient error while a debate runs.
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    vi.spyOn(PanelRepository.prototype, "findByNamePrefix").mockRejectedValue(busy);

    let captured = "";
    const cmd = buildPanelCommand((s) => {
      captured += s;
    });
    // With --yes the unguarded read must not be reached; delete proceeds.
    await cmd.parseAsync(["node", "council-panel", "delete", "concurrent-debate", "--yes"]);

    expect(captured).toMatch(/deleted/i);
    await expect(fs.access(yamlPath)).rejects.toThrow();
  });

  it("#309: db.destroy() failure does not mask the callback error", async () => {
    // Make the in-context callback throw (unknown panel) AND db.destroy()
    // throw. The primary CliUserError must remain the thrown error so its exit
    // code survives (#1825) — a bare AggregateError would map to
    // EXIT_INTERNAL_ERROR instead of the user-error code. Both failures stay
    // reachable via `.cause`.
    vi.spyOn(Kysely.prototype, "destroy").mockRejectedValue(new Error("destroy boom"));

    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    let caught: unknown;
    try {
      await cmd.parseAsync(["node", "council-panel", "delete", "ghost-panel", "--yes"]);
    } catch (err) {
      caught = err;
    }
    // The primary error is surfaced as a CliUserError (preserving user-error
    // exit semantics), not masked behind a bare AggregateError (#1825).
    expect(caught).toBeInstanceOf(CliUserError);
    expect((caught as CliUserError).message).toMatch(/not found/i);
    // Both the primary and cleanup failures remain reachable via `.cause`.
    const cause = (caught as CliUserError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    const messages = (cause as AggregateError).errors.map((e) => String((e as Error).message));
    expect(messages.some((m) => /not found/i.test(m))).toBe(true);
    expect(messages.some((m) => /destroy boom/i.test(m))).toBe(true);
  });
});

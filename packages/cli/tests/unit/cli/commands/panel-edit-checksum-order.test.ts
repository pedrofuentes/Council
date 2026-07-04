/**
 * `panel edit` membership/checksum write is ATOMIC (#1931, subsumes #308).
 *
 * The edit path persists the new membership (`panel_members`) and the new
 * `panel_library` row/checksum. Historically these were TWO independent DB
 * writes (`setMembers` then `update`): a crash — or any failure — between them
 * left the panel half-updated (new membership committed, stale checksum, or
 * vice-versa). #308 mitigated one ordering of that split; #1931 removes the
 * split entirely by wrapping BOTH writes in a single transaction so they are
 * applied together or not at all.
 *
 * This test drives `panel edit` with a no-op editor over a YAML whose bytes
 * (and membership) differ from the stored row, then forces the SECOND write —
 * the `panel_library` UPDATE — to fail. With the two writes wrapped in one
 * transaction, the membership change must ROLL BACK (both-or-neither) and the
 * stored checksum must stay at its pre-edit value. Without atomicity the
 * membership write would already be committed by the time the UPDATE fails.
 *
 * The failure is injected at `Kysely.prototype.updateTable`: in the edit flow
 * (createDatabase runs no UPDATEs on an already-migrated DB; findByName +
 * assertExpertsExist are SELECTs; membership is DELETE+INSERT) the FIRST
 * `updateTable` call is the `panel_library` UPDATE, so `mockImplementationOnce`
 * targets exactly the second write.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import * as yaml from "yaml";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { toSingleLineDisplay } from "../../../../src/cli/strip-control-chars.js";
import { createDatabase } from "../../../../src/memory/db.js";
import * as dbModule from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Every terminal-injection codepoint class: C0 controls (incl. CR/LF), DEL,
// C1 controls, the Unicode line/paragraph separators, and the bidi
// override/isolate marks. Matching any of these in a surfaced error message
// means an escape survived to the operator's terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Wrap the libsql Kysely executor so the next `executeQuery` whose SQL contains
 * `failOnSqlSubstring` throws, and (optionally) any subsequent `ROLLBACK` throws
 * too. Mirrors the helper in memory/panel-library-repo.test.ts so we can drive
 * the BEGIN/COMMIT/ROLLBACK paths of `persistPanelEditAtomically` — including a
 * failed rollback — without corrupting the driver. `executeQuery` is overridden
 * as an own-property on the executor instance because Kysely's executor uses
 * private class fields and a Proxy would re-bind `this` and break private access.
 */
function patchExecuteQuery(
  database: dbModule.CouncilDatabase,
  opts: {
    failOnSqlSubstring: string;
    failRollback?: boolean;
    errorMessage?: string;
    rollbackError?: Error;
  },
): () => void {
  const realExec = database.getExecutor();
  type ExecQueryFn = typeof realExec.executeQuery;
  const originalExecuteQuery: ExecQueryFn = realExec.executeQuery as ExecQueryFn;
  const wrapped: ExecQueryFn = async function (this: typeof realExec, compiled, queryId) {
    const text = compiled.sql;
    if (text.includes(opts.failOnSqlSubstring)) {
      throw new Error(opts.errorMessage ?? `simulated failure on: ${opts.failOnSqlSubstring}`);
    }
    if (opts.failRollback === true && /^\s*ROLLBACK\b/i.test(text)) {
      throw opts.rollbackError ?? new Error("simulated ROLLBACK failure");
    }
    return originalExecuteQuery.call(this, compiled, queryId);
  };
  Object.defineProperty(realExec, "executeQuery", {
    value: wrapped,
    configurable: true,
    writable: true,
  });
  return () => {
    delete (realExec as { executeQuery?: ExecQueryFn }).executeQuery;
  };
}

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
  readonly originalEditor: string | undefined;
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
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-edit-order-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-edit-order-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  const originalEditor = process.env["EDITOR"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  process.env["EDITOR"] = `node -e ""`;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome, originalEditor };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  if (env.originalEditor === undefined) delete process.env["EDITOR"];
  else process.env["EDITOR"] = env.originalEditor;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

describe("panel edit — atomic membership+checksum write (#1931, #308)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("rolls back the membership change when the panel_library update fails", async () => {
    await seedExpert(env, expertDef("cto"));
    await seedExpert(env, expertDef("security"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "arch-review",
      "--experts",
      "cto",
    ]);

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");

    // Capture the pre-edit checksum and membership.
    let originalChecksum: string | undefined;
    {
      const db = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(db);
        originalChecksum = (await repo.findByName("arch-review"))?.yamlChecksum;
        expect(await repo.getMembers("arch-review")).toEqual(["cto"]);
      } finally {
        await db.destroy();
      }
    }
    expect(originalChecksum).toBeTruthy();

    // Mutate the on-disk YAML so BOTH its bytes (checksum) and its membership
    // change: add "security". A valid edit that alters the panel membership.
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    parsed["description"] = "edited by test — changes the file bytes";
    parsed["experts"] = ["cto", "security"];
    await fs.writeFile(yamlPath, yaml.stringify(parsed), "utf-8");

    // Force the SECOND write (the panel_library UPDATE) to fail. This is the
    // first `updateTable` call in the edit flow, so `mockImplementationOnce`
    // targets exactly the row/checksum write — after the membership write.
    const updateSpy = vi.spyOn(Kysely.prototype, "updateTable").mockImplementationOnce(() => {
      throw new Error("simulated panel_library update failure");
    });

    const editCmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    const err = await editCmd.parseAsync(["node", "council-panel", "edit", "arch-review"]).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Atomicity: because the two writes share one transaction, the failing
    // UPDATE must roll the membership write back too. Membership stays ["cto"]
    // (NOT ["cto", "security"]) and the checksum stays at its pre-edit value.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelLibraryRepository(db);
      expect(await repo.getMembers("arch-review")).toEqual(["cto"]);
      const row = await repo.findByName("arch-review");
      expect(row?.yamlChecksum).toBe(originalChecksum);
    } finally {
      await db.destroy();
    }
  });

  it("preserves the ROLLBACK failure reason on the surfaced error when rollback also fails", async () => {
    await seedExpert(env, expertDef("cto"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "arch-review",
      "--experts",
      "cto",
    ]);

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    parsed["description"] = "edited by test — changes the file bytes";
    await fs.writeFile(yamlPath, yaml.stringify(parsed), "utf-8");

    // Patch the edit command's internal db so BOTH the panel_library UPDATE
    // (the second write) AND the subsequent ROLLBACK fail — the same seam the
    // setMembers rollback-honesty test uses. `mockImplementationOnce` scopes the
    // patch to the edit command's connection only. The ROLLBACK is failed with a
    // KNOWN instance so the test can pin that the surfaced `rollbackError` is
    // that exact object, not merely some Error.
    const injectedRollbackError = new Error("injected ROLLBACK failure — pin me");
    const realCreate = dbModule.createDatabase;
    const createSpy = vi
      .spyOn(dbModule, "createDatabase")
      .mockImplementationOnce(async (dbPath: string) => {
        const db = await realCreate(dbPath);
        patchExecuteQuery(db, {
          failOnSqlSubstring: 'update "panel_library"',
          failRollback: true,
          rollbackError: injectedRollbackError,
        });
        return db;
      });

    const editCmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    const err = await editCmd.parseAsync(["node", "council-panel", "edit", "arch-review"]).then(
      () => null,
      (e: unknown) => e,
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(Error);
    // The finding (#1931): on a ROLLBACK failure the surfaced error must PRESERVE
    // the underlying rollback error REASON for diagnostics — not collapse it to a
    // bare boolean — mirroring PanelLibraryRepository.setMembers, which attaches
    // `rollbackError`. The message must stay honest (inconsistent, NOT preserved).
    const surfaced = err as { rollbackFailed?: boolean; rollbackError?: unknown; message: string };
    expect(surfaced.rollbackFailed).toBe(true);
    // Identity, not just `instanceof`: the surfaced error must carry the EXACT
    // rollback error object so the underlying reason is diagnosable, never a
    // re-wrapped or synthesized stand-in.
    expect(surfaced.rollbackError).toBe(injectedRollbackError);
    expect(surfaced.message).toMatch(/inconsistent/i);
    expect(surfaced.message).not.toMatch(/preserved/i);
  });

  it("sanitizes control/ANSI/bidi bytes in the surfaced detail when the panel_library UPDATE fails (#1931 item a)", async () => {
    await seedExpert(env, expertDef("cto"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "arch-review",
      "--experts",
      "cto",
    ]);

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    parsed["description"] = "edited by test — changes the file bytes";
    await fs.writeFile(yamlPath, yaml.stringify(parsed), "utf-8");

    // A DB driver error message is untrusted (it can echo file paths / SQL
    // fragments) and here carries a full terminal-injection payload: CR/LF,
    // ANSI CSI + OSC, C0 BEL, DEL, C1 CSI (0x9B), and an RLO bidi override.
    const noisyDetail =
      "db exploded:\t\u0007\u009b\u007f\u202e\r\n\u2028\u2029 \u001b[31mRED\u001b]0;pwn\u0007 payload";
    const realCreate = dbModule.createDatabase;
    const createSpy = vi
      .spyOn(dbModule, "createDatabase")
      .mockImplementationOnce(async (dbPath: string) => {
        const db = await realCreate(dbPath);
        patchExecuteQuery(db, {
          failOnSqlSubstring: 'update "panel_library"',
          errorMessage: noisyDetail,
        });
        return db;
      });

    const editCmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    const surfaced = await editCmd
      .parseAsync(["node", "council-panel", "edit", "arch-review"])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(surfaced).toBeInstanceOf(Error);
    const message = (surfaced as Error).message;
    // The surfaced `.message` is what `handleCliError` writes verbatim to
    // stderr, so it must be a single control-free line: no CR/LF/ANSI/OSC/C1/
    // DEL/bidi byte may survive, and it must be a fixed point of the sanitizer.
    expect(message).not.toMatch(CONTROL_RE);
    expect(message).toBe(toSingleLineDisplay(message));
    // The legitimate diagnostic still comes through.
    expect(message).toContain("db exploded:");
    expect(message).toContain("payload");
  });

  it("sanitizes control/ANSI/bidi bytes in the surfaced detail when BEGIN fails (#1931 item a)", async () => {
    await seedExpert(env, expertDef("cto"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "arch-review",
      "--experts",
      "cto",
    ]);

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    const parsed = yaml.parse(await fs.readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    parsed["description"] = "edited by test — changes the file bytes";
    await fs.writeFile(yamlPath, yaml.stringify(parsed), "utf-8");

    const noisyDetail = "BEGIN blew up\r\n\u001b[31mHACKED\u001b[0m\u0007\u009b tail";
    const realCreate = dbModule.createDatabase;
    const createSpy = vi
      .spyOn(dbModule, "createDatabase")
      .mockImplementationOnce(async (dbPath: string) => {
        const db = await realCreate(dbPath);
        patchExecuteQuery(db, { failOnSqlSubstring: "BEGIN", errorMessage: noisyDetail });
        return db;
      });

    const editCmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    const surfaced = await editCmd
      .parseAsync(["node", "council-panel", "edit", "arch-review"])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(surfaced).toBeInstanceOf(Error);
    const message = (surfaced as Error).message;
    expect(message).not.toMatch(CONTROL_RE);
    expect(message).toBe(toSingleLineDisplay(message));
    expect(message).toContain("tail");
  });
});

/**
 * `panel delete` — DB-delete failure after FS removal (#1643).
 *
 * Sentinel SENTINEL-20260623-185610 🟡: delete order is unlink YAML →
 * `fs.rm(panelDir)` → `panelRepo.delete(name)`. If the final DB delete fails,
 * the YAML/docs are already gone but the `panel_library` row remains — a stale
 * row with no on-disk artifacts, and the raw rejection gave the operator no
 * guidance.
 *
 * The FS-first ordering is deliberate (a filesystem failure keeps the row
 * authoritative for a retry). This test pins the missing half: when the DB
 * delete fails, the command must surface actionable recovery guidance
 * (re-running `panel delete` clears the stale row, since the missing YAML/dir
 * are tolerated) rather than a bare rejection.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { panelDeleteRecoveryMessage } from "../../../../src/cli/panel-delete-recovery.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
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
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function createPanel(env: TestEnv, name: string): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync(["node", "council-panel", "create", name, "--experts", "cto"]);
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-del-recover-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-del-recover-data-"));
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

describe("panel delete — DB-delete failure recovery (#1643)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("emits recovery guidance (re-run to clear the stale row) when the DB delete fails", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "arch-review");
    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    const panelDir = path.join(env.dataHome, "panels", "arch-review");

    const delSpy = vi
      .spyOn(PanelLibraryRepository.prototype, "delete")
      .mockRejectedValueOnce(new Error("simulated DB delete failure"));

    let errored = "";
    let out = "";
    const cmd = buildPanelCommand(
      (s) => {
        out += s;
      },
      (s) => {
        errored += s;
      },
    );

    const err = await cmd
      .parseAsync(["node", "council-panel", "delete", "arch-review", "--yes"])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(delSpy).toHaveBeenCalledTimes(1);
    // The command must fail (the row was NOT removed) with a CliUserError so
    // the top-level handler exits non-zero without a stack dump (#1930).
    expect(err).toBeInstanceOf(CliUserError);
    // ... the FS artifacts are already gone (FS-first ordering) ...
    await expect(fs.access(yamlPath)).rejects.toThrow();
    await expect(fs.access(panelDir)).rejects.toThrow();
    // ... it must NOT print a success line ...
    expect(out).not.toMatch(/deleted/i);
    // ... and it must guide the operator with the *actionable* recovery
    // phrase. A broad alternation like /…|remove/i is non-discriminating: it
    // is satisfied by the "Removed the panel files…" prefix alone, so a
    // regression that dropped the "Re-run `council panel delete <name>`"
    // sentence would still pass. Pin that specific phrase instead (#1930).
    expect(errored).toMatch(/re-run[^]*council panel delete[^]*arch-review/i);
  });
});

describe("panelDeleteRecoveryMessage (shared #1643 recovery guidance)", () => {
  it("pins the actionable re-run guidance including the panel name and failure detail", () => {
    const msg = panelDeleteRecoveryMessage("arch-review", "EIO: i/o error");
    expect(msg).toContain("Re-run `council panel delete arch-review` to clear it");
    expect(msg).toMatch(/re-run[^]*council panel delete[^]*arch-review/i);
    expect(msg).toContain("EIO: i/o error");
  });

  it("neutralizes adversarial control/ANSI/bidi bytes and collapses to a single line", () => {
    // TAB, BEL, C1 (0x9B = CSI), DEL, bidi override/isolate, CR/LF, LS/PS —
    // both the interpolated name and the failure detail are sanitized.
    const hostileName = "a\u0009b\u0007\u009bc\u007f\u202e\u2066d\r\ne\u2028f\u2029g";
    const msg = panelDeleteRecoveryMessage(hostileName, "d\u0000e\u2028t\u202aail");
    // eslint-disable-next-line no-control-regex -- deliberately asserts C0/C1/DEL/bidi bytes are absent
    expect(msg).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    expect(msg.split("\n")).toHaveLength(1);
    // The literal guidance survives sanitization.
    expect(msg).toContain("council panel delete");
  });
});

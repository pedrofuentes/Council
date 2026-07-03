/**
 * `panel delete` — filesystem-cleanup failure diagnostics are terminal-safe
 * (#1931 item a, security-path).
 *
 * The delete flow is unlink YAML → `fs.rm(panelDir)` → `panelRepo.delete`. The
 * two filesystem catch sinks (`Failed to delete YAML at …: <detail>` and
 * `Warning: failed to clean up …: <detail>`) interpolate the raw fs
 * `err.message`. That message embeds the offending path, which derives from
 * `panel_library.name` — a value that can be populated via
 * migration/import/direct DB edit and is therefore untrusted — so a crafted
 * error can smuggle ANSI/OSC/C0/C1/DEL/bidi bytes onto the operator's terminal.
 *
 * These tests force each fs step to reject with an adversarial message and pin
 * that the surfaced stderr is control-free while still naming the failure.
 *
 * RED before the fix: the raw escapes reach stderr unsanitized.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type FsPromisesModule from "node:fs/promises";

// Controllable fs mock: when armed, `unlink`/`rm` reject with the supplied
// error; otherwise they delegate to the real implementation so env setup,
// panel creation and teardown all use the genuine filesystem.
const fsControl = vi.hoisted(() => ({
  unlinkError: null as Error | null,
  rmError: null as Error | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    unlink: (async (...args: unknown[]) => {
      if (fsControl.unlinkError) throw fsControl.unlinkError;
      return (actual.unlink as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.unlink,
    rm: (async (...args: unknown[]) => {
      if (fsControl.rmError) throw fsControl.rmError;
      return (actual.rm as (...a: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.rm,
  };
});

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createDatabase } from "../../../../src/memory/db.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Every codepoint class a terminal can be induced to (mis)interpret: C0
// controls (incl. CR/LF), DEL, C1 controls, the Unicode line/paragraph
// separators, and the bidi override/isolate marks. Matching any of these in a
// surfaced line means an escape survived to the terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Assert no line carries a terminal-injection control byte. Checking per line
 * allows the legitimate `\n` sentence separators the sinks emit while still
 * catching a bare CR or any injected control char inside a line.
 */
function expectNoControlChars(text: string): void {
  for (const line of text.split("\n")) {
    expect(line).not.toMatch(CONTROL_RE);
  }
}

// A message packing several injection classes (CSI, BEL, C1 CSI, DEL, bidi,
// CR/LF, LS/PS) plus a plausible errno prefix and path snippet.
const ADVERSARIAL_DETAIL =
  "EACCES \u001b[31m\u0007\u009b\u007f\u202e\u2066\r\n\u2028\u2029 /panels/arch-review";

function errnoError(message: string, code: string): Error {
  const e = new Error(message);
  (e as NodeJS.ErrnoException).code = code;
  return e;
}

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

async function createPanel(): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]);
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-del-san-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-del-san-data-"));
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

async function runDelete(): Promise<{ out: string; err: string; error: unknown }> {
  let out = "";
  let err = "";
  const cmd = buildPanelCommand(
    (s) => {
      out += s;
    },
    (s) => {
      err += s;
    },
  );
  const error = await cmd
    .parseAsync(["node", "council-panel", "delete", "arch-review", "--yes"])
    .then(
      () => null,
      (e: unknown) => e,
    );
  return { out, err, error };
}

describe("panel delete — fs-cleanup failure diagnostics are terminal-safe (#1931 item a)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    fsControl.unlinkError = null;
    fsControl.rmError = null;
    env = await makeEnv();
    await seedExpert(env, expertDef("cto"));
    await createPanel();
  });
  afterEach(async () => {
    // Disarm BEFORE teardown so the genuine fs.rm cleanup runs.
    fsControl.unlinkError = null;
    fsControl.rmError = null;
    vi.restoreAllMocks();
    await teardown(env);
  });

  it("neutralizes injected escapes in the YAML-unlink failure diagnostic", async () => {
    fsControl.unlinkError = errnoError(ADVERSARIAL_DETAIL, "EACCES");
    const { err, error } = await runDelete();

    // A non-ENOENT unlink failure preserves the DB row and surfaces the error.
    expect(error).not.toBeNull();
    expect(err).toMatch(/failed to delete yaml/i);
    expectNoControlChars(err);
    expect(err).not.toContain("\u001b[31m");
    expect(err).not.toContain("\u0007");
    expect(err).not.toContain("\u009b");
  });

  it("neutralizes injected escapes in the docs-dir cleanup failure diagnostic", async () => {
    // Let the real unlink succeed (removes the YAML), then fail `fs.rm`.
    fsControl.rmError = errnoError(ADVERSARIAL_DETAIL, "EPERM");
    const { err, error } = await runDelete();

    expect(error).not.toBeNull();
    expect(err).toMatch(/failed to clean up/i);
    expectNoControlChars(err);
    expect(err).not.toContain("\u001b[31m");
    expect(err).not.toContain("\u0007");
    expect(err).not.toContain("\u009b");
  });
});

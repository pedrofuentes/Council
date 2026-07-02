/**
 * #1978 (security — terminal injection): `council panel save` echoes the
 * malformed-`config_json` diagnostic to stderr. That diagnostic embeds the
 * V8 `JSON.parse` error message (`template-loader.ts` →
 * `config_json is not valid JSON: ${err.message}`), which quotes a snippet of
 * the untrusted `config_json`. A crafted `config_json` can therefore smuggle
 * ANSI/OSC/C0/C1/DEL/bidi control bytes into the parse-error message and, at
 * the sink (`panel.ts`), straight onto the user's terminal.
 *
 * The ADJACENT `sessionName` in the same `writeError(...)` is already run
 * through `toSingleLineDisplay`; the invalid-template `stored.message` is NOT.
 * These tests pin that the surfaced stderr is single-line and control-free
 * while still conveying the legitimate "invalid JSON" diagnostic.
 *
 * RED before the fix: the raw escapes reach stderr unsanitized.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type { ResolvedPanelDefinition } from "../../../../src/core/template-loader.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Every codepoint class a terminal can be induced to (mis)interpret: C0
// controls, DEL, C1 controls, the Unicode line/paragraph separators, and the
// bidi override/isolate marks (Trojan Source, CVE-2021-42574). Matching any of
// these in the surfaced diagnostic means an escape survived to the terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panelsan-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panelsan-data-"));
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

/** Seed a session row whose `config_json` is the given raw (corrupt) string. */
async function seedRawConfig(env: TestEnv, name: string, configJson: string): Promise<string> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const repo = new PanelRepository(db);
    const panel = await repo.create({
      name,
      topic: "Should we adopt event sourcing?",
      copilotHome: path.join(env.home, "copilot"),
      configJson,
    });
    return panel.name;
  } finally {
    await db.destroy();
  }
}

/** Run `panel save <session> foo`, capturing stderr and any thrown error. */
async function runSave(
  session: string,
): Promise<{ readonly stderr: string; readonly err: unknown }> {
  let stderr = "";
  const cmd = buildPanelCommand(
    () => undefined,
    (s) => {
      stderr += s;
    },
  );
  cmd.exitOverride();
  const err = await cmd.parseAsync(["node", "council-panel", "save", session, "foo"]).then(
    () => null,
    (e: unknown) => e,
  );
  return { stderr, err };
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `${slug} (Role)`,
    role: `${slug} role`,
    model: "test-model",
    expertise: {
      weightedEvidence: [`${slug}-evidence`],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: `${slug} forms beliefs empirically.`,
    kind: "generic",
  };
}

function validDefinition(): ResolvedPanelDefinition {
  return {
    name: "auto-panel",
    description: "Auto-composed panel for the topic",
    experts: [expertDef("alpha"), expertDef("beta"), expertDef("gamma")],
  };
}

// Each payload is prefixed with "!" so `JSON.parse` fails at position 0 and the
// V8 error message quotes the adversarial bytes that immediately follow (the
// snippet window is short, so packing the escapes at the head keeps them in the
// quoted range). Together these cover every class in CONTROL_RE.
const ADVERSARIAL_PAYLOADS: readonly { readonly label: string; readonly configJson: string }[] = [
  {
    // TAB, BEL (C0), C1 CSI (0x9B), DEL, RLO + LRI (bidi), CR, LF, and the
    // Unicode line/paragraph separators — all single-codepoint escapes.
    label: "C0/C1/DEL/bidi/CR-LF/U+2028-U+2029",
    configJson: "!\t\u0007\u009b\u007f\u202e\u2066\r\n\u2028\u2029",
  },
  {
    // ANSI CSI SGR sequence (colour reset spoofing).
    label: "ANSI CSI \\u001b[31m",
    configJson: "!\u001b[31mHACKED\u001b[0m",
  },
  {
    // OSC set-window-title / hyperlink introducer, BEL-terminated.
    label: "OSC set-title",
    configJson: "!\u001b]0;pwned\u0007",
  },
];

describe("panel save — malformed config_json diagnostic is terminal-safe (#1978)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardown(env);
  });

  // (1) Adversarial-byte oracle: whatever escape class the parse-error snippet
  // carries, the surfaced stderr must be single-line and control-free.
  it.each(ADVERSARIAL_PAYLOADS)(
    "neutralizes injected escapes in the diagnostic ($label)",
    async ({ configJson }) => {
      const session = await seedRawConfig(env, "corrupt-2026-06-15T18:00:00", configJson);
      const { stderr, err } = await runSave(session);

      // The command still fails the save (the config really is corrupt).
      expect(err).toBeInstanceOf(CliUserError);

      // The sink terminates the single diagnostic line with exactly one newline;
      // drop it so the control-free assertion doesn't trip on that terminator.
      const surfaced = stderr.replace(/\n$/, "");
      // Single-line: no interior CR/LF/LS/PS survives (all in CONTROL_RE too).
      expect(surfaced.split(/\r?\n/)).toHaveLength(1);
      // Control-free: no escape byte from any class reaches the terminal.
      expect(surfaced).not.toMatch(CONTROL_RE);
      // The legitimate diagnostic is still conveyed (not swallowed to nothing).
      expect(surfaced).toMatch(/invalid or corrupt/i);
    },
  );

  // (2) Discriminating: the sanitized diagnostic keeps its meaning (invalid
  // JSON) while the SPECIFIC injected escape bytes are gone.
  it("keeps the invalid-JSON diagnostic while dropping the exact injected bytes", async () => {
    // CSI + BEL (C0) + C1 CSI packed at the head of the config.
    const session = await seedRawConfig(
      env,
      "corrupt-2026-06-15T19:00:00",
      "!\u001b[31m\u0007\u009b oops",
    );
    const { stderr, err } = await runSave(session);

    expect(err).toBeInstanceOf(CliUserError);
    // Legit text survives and is non-empty.
    expect(stderr).toMatch(/invalid or corrupt/i);
    expect(stderr).toMatch(/config_json is not valid JSON/i);
    expect(stderr.length).toBeGreaterThan(0);
    // The exact injected escape bytes are absent from the surfaced output.
    expect(stderr).not.toContain("\u001b[31m");
    expect(stderr).not.toContain("\u0007");
    expect(stderr).not.toContain("\u009b");
    // And, dropping the sink's single trailing newline, nothing control-like
    // survives at all.
    expect(stderr.replace(/\n$/, "")).not.toMatch(CONTROL_RE);
  });

  // (3) Inverse: a well-formed config_json save path is unaffected — no
  // spurious "invalid or corrupt" diagnostic, and the save succeeds.
  it("does not surface a corruption diagnostic for a valid config_json", async () => {
    const validConfig = JSON.stringify({
      template: "auto-panel",
      mode: "freeform",
      engine: "mock",
      definition: validDefinition(),
    });
    const session = await seedRawConfig(env, "auto-panel-2026-06-15T20:00:00", validConfig);

    let stdout = "";
    let stderr = "";
    const cmd = buildPanelCommand(
      (s) => {
        stdout += s;
      },
      (s) => {
        stderr += s;
      },
    );
    const err = await cmd.parseAsync(["node", "council-panel", "save", session, "mypanel"]).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeNull();
    expect(stderr).not.toMatch(/invalid or corrupt/i);
    expect(stdout).toMatch(/Saved session/i);
  });
});

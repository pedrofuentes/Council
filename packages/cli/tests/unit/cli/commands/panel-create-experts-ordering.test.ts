/**
 * Ordering guidance for the variadic `--experts <slugs...>` option in
 * `council panel create` (#1059).
 *
 * Because `--experts` is variadic, a panel name placed AFTER it is greedily
 * consumed as another expert slug, leaving the positional <name> empty. The
 * failure is loud (no silent data loss), but neither the create help text nor
 * the "Panel name is required" error explained the ordering constraint —
 * convene already documents and warns about the identical foot-gun, panel
 * create did not. This suite pins:
 *   1. the create help documents the ordering foot-gun and the SAFE orderings,
 *   2. the missing-name error hints at it when --experts was supplied (and
 *      stays quiet when it was not), including when a hostile trailing slug is
 *      absorbed (the static hint never echoes it), and
 *   3. valid orderings (name-first) are unaffected and never trigger the hint.
 *
 * Empirically verified against Commander 15 (the version this package pins):
 *   `create --experts a b mypanel`          -> name=undefined (absorbed)
 *   `create --experts "a,b" mypanel`        -> name=undefined (quoting does NOT
 *                                              rescue a TRAILING name)
 *   `create mypanel --experts a b`          -> name="mypanel"   (safe)
 *   `create --experts a b --slug mypanel`   -> name="mypanel"   (safe)
 * so the guidance points users at name-first / `--slug`, NOT at quoting alone.
 *
 * Help text is captured via `configureOutput` + `outputHelp()` because
 * Commander's `helpInformation()` OMITS `addHelpText("after")` content.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import type { Command } from "commander";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

/**
 * Control/format characters that must never reach a single-line terminal sink
 * (C0/C1 controls, DEL, line/paragraph separators, and bidi overrides/isolates).
 */
const ADVERSARIAL_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function getCreateCommand(): Command {
  const cmd = buildPanelCommand(
    () => undefined,
    () => undefined,
  );
  const create = cmd.commands.find((c) => c.name() === "create");
  if (create === undefined) throw new Error("panel create subcommand not found");
  return create;
}

function renderCreateHelp(): string {
  const create = getCreateCommand();
  let captured = "";
  create.configureOutput({
    writeOut: (chunk: string) => {
      captured += chunk;
    },
    writeErr: (chunk: string) => {
      captured += chunk;
    },
  });
  create.outputHelp();
  return captured;
}

describe("panel create help — --experts ordering guidance (#1059)", () => {
  it("explains that --experts is variadic and can consume a trailing panel name", () => {
    const helpText = renderCreateHelp();
    expect(helpText).toMatch(/--experts/);
    expect(helpText).toMatch(/variadic/i);
    expect(helpText).toMatch(/consum|swallow|absorb/i);
  });

  it("tells the user to put the name before --experts (or use --slug)", () => {
    const helpText = renderCreateHelp();
    expect(helpText).toMatch(/name (first|before)|before --experts|put the name|before it/i);
    expect(helpText).toMatch(/--slug/);
  });

  /**
   * DISCRIMINATING oracle for the after-help "Expert ordering" section (#1059).
   *
   * The generic assertions above also match the `--experts` OPTION description
   * that precedes the after-help block, so they alone do NOT prove the
   * `addHelpText("after", …)` section is present — deleting that block would
   * leave them green. This test pins strings UNIQUE to the after-help section:
   * its "Expert ordering:" heading and the two worked-example command lines
   * with their inline safety annotations. None of these appear in the option
   * description, so the after-help block is load-bearing. Captured via
   * `outputHelp()` because Commander's `helpInformation()` OMITS
   * `addHelpText("after")` content.
   */
  it("renders the after-help 'Expert ordering' section with safe worked examples", () => {
    const helpText = renderCreateHelp();
    // Section heading — appears only in the addHelpText("after") block.
    expect(helpText).toContain("Expert ordering:");
    // Name-first worked example + its inline "safe" annotation live only in the
    // after-help block, never in the --experts option description.
    expect(helpText).toContain("$ council panel create my-panel --experts senior security");
    expect(helpText).toContain("# name first — safe");
    // --slug worked example + its inline "safe" annotation, likewise unique to
    // the after-help block.
    expect(helpText).toContain("$ council panel create --experts senior security --slug my-panel");
    expect(helpText).toContain("# --slug — safe");
  });
});

describe("panel create missing-name error — --experts ordering hint (#1059)", () => {
  it("hints at the ordering foot-gun when a trailing name was absorbed by --experts", async () => {
    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s: string) => {
        stderr += s;
      },
    );
    cmd.exitOverride();

    // The trailing "mypanel" is swallowed by the variadic --experts, so the
    // positional <name> ends up empty.
    await expect(
      cmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "--experts",
        "alpha",
        "beta",
        "gamma",
        "mypanel",
      ]),
    ).rejects.toThrow(/panel name/i);

    // Discriminating oracles — pin the actual guidance, not bare presence.
    expect(stderr).toContain("--experts is variadic");
    expect(stderr).toMatch(/consum/i);
    expect(stderr).toMatch(/put the name FIRST/);
    expect(stderr).toContain("--slug");
    // Static hint — no user args interpolated — so nothing hostile can reach
    // the terminal sink (verify no control bytes beyond the trailing newline).
    expect(stderr.trimEnd()).not.toMatch(ADVERSARIAL_CONTROL_RE);
  });

  it("also hints when --experts was supplied but no name was given at all", async () => {
    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s: string) => {
        stderr += s;
      },
    );
    cmd.exitOverride();

    await expect(
      cmd.parseAsync(["node", "council-panel", "create", "--experts", "alpha", "beta"]),
    ).rejects.toThrow(/panel name/i);

    expect(stderr).toContain("--experts is variadic");
    expect(stderr).toMatch(/put the name FIRST/);
  });

  it("keeps the hint control-free and never echoes a hostile absorbed slug", async () => {
    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s: string) => {
        stderr += s;
      },
    );
    cmd.exitOverride();

    // A single argv element carrying ANSI + BEL + newline + bidi override that
    // the variadic --experts absorbs as the (would-be) trailing name.
    const hostile = "evil\u001b[31m\u0007\u202emoc\u2066\nmypanel";
    await expect(
      cmd.parseAsync(["node", "council-panel", "create", "--experts", "alpha", hostile]),
    ).rejects.toThrow(/panel name/i);

    // The hint is STATIC — it never interpolates the absorbed slug, so no
    // adversarial byte from user input can reach the terminal sink.
    expect(stderr).toContain("--experts is variadic");
    expect(stderr).not.toContain("evil");
    expect(stderr.trimEnd()).not.toMatch(ADVERSARIAL_CONTROL_RE);
  });

  it("does not show the --experts ordering hint when --experts was not supplied", async () => {
    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s: string) => {
        stderr += s;
      },
    );
    cmd.exitOverride();

    await expect(cmd.parseAsync(["node", "council-panel", "create"])).rejects.toThrow(
      /panel name/i,
    );

    expect(stderr).toMatch(/panel name is required/i);
    expect(stderr).not.toMatch(/variadic/i);
  });
});

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-order-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-order-data-"));
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

async function panelExpertSlugs(env: TestEnv, panelName: string): Promise<readonly string[]> {
  const yamlPath = path.join(env.dataHome, "panels", `${panelName}.yaml`);
  const content = await fs.readFile(yamlPath, "utf-8");
  const parsed = parseYaml(content) as { experts?: readonly string[] };
  return [...(parsed.experts ?? [])].sort();
}

describe("panel create — valid ordering unaffected (#1059)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
    await seedExpert(env, expertDef("cto"));
    await seedExpert(env, expertDef("cmo"));
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("name-first ordering creates the panel and never emits the ordering hint", async () => {
    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s: string) => {
        stderr += s;
      },
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "name-first-panel",
      "--experts",
      "cto",
      "cmo",
    ]);
    // The panel is created with both experts...
    expect(await panelExpertSlugs(env, "name-first-panel")).toEqual(["cmo", "cto"]);
    // ...and the correct (name-first) usage never trips the ordering hint.
    expect(stderr).not.toMatch(/variadic/i);
  });

  it("--slug after --experts is a safe ordering and never emits the hint", async () => {
    let stderr = "";
    const cmd = buildPanelCommand(
      () => undefined,
      (s: string) => {
        stderr += s;
      },
    );
    await cmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "--experts",
      "cto",
      "cmo",
      "--slug",
      "slug-panel",
    ]);
    expect(await panelExpertSlugs(env, "slug-panel")).toEqual(["cmo", "cto"]);
    expect(stderr).not.toMatch(/variadic/i);
  });
});

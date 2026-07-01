/**
 * Path-traversal guard for the generic-expert unindexed-docs warning on the
 * panel/convene startup path (#1103, Sentinel dimension A2).
 *
 * `warnIfGenericExpertHasUnindexedDocs` builds `experts/<slug>/docs` from an
 * expert's `slug` and readdir()s it, then names the resolved path + file count
 * in a terminal warning. On the panel path a member can be an INLINE
 * `ExpertDefinition` whose `slug` is only schema-validated as a non-empty
 * string (`ExpertDefinitionSchema` — no charset/`..` gate), so a hand-authored
 * or shared panel YAML can smuggle a traversal slug (e.g. `../../../../etc`)
 * that escapes the per-expert docs root. The sink must confine the slug BEFORE
 * touching the filesystem: never readdir outside `<dataHome>/experts/<slug>` and
 * never disclose an out-of-tree path.
 *
 * ESM namespaces cannot be spied, so this dedicated file mocks
 * `node:fs/promises` (calling through to the real implementation) to observe the
 * `readdir` boundary — mirroring `template-migration-fileexists.test.ts`.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildChatCommand, type ChatInputProvider } from "../../../../src/cli/commands/chat.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = (await importOriginal()) as typeof fs;
  return { ...real, readdir: vi.fn(real.readdir) };
});

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-slug-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-slug-data-"));
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

/**
 * Serialize a single INLINE generic panel member. The `slug` is emitted as a
 * double-quoted YAML scalar (via JSON.stringify) so traversal segments and
 * control bytes survive parsing verbatim into `ExpertDefinition.slug`.
 */
function inlineGenericMemberYaml(slug: string): string {
  return [
    `  - slug: ${JSON.stringify(slug)}`,
    `    displayName: Adversary`,
    `    role: Attacker`,
    `    expertise:`,
    `      weightedEvidence:`,
    `        - nothing`,
    `    epistemicStance: adversarial`,
    `    kind: generic`,
  ].join("\n");
}

async function writeInlinePanel(dataHome: string, name: string, memberYaml: string): Promise<void> {
  const dir = path.join(dataHome, "panels");
  await fs.mkdir(dir, { recursive: true });
  const doc =
    [`name: ${name}`, `description: Traversal guard test`, `experts:`, memberYaml].join("\n") +
    "\n";
  await fs.writeFile(path.join(dir, `${name}.yaml`), doc, "utf-8");
}

function runPanel(target: string): { parse: () => Promise<void>; out: () => string } {
  let out = "";
  const cmd = buildChatCommand({
    write: (s: string) => (out += s),
    // Combine stderr into the same buffer so a disclosure to EITHER stream fails.
    writeError: (s: string) => (out += s),
    engineFactory: () => new MockEngine(),
    inputProvider: () => scriptedInput(["/quit"]),
  });
  return {
    parse: () => cmd.parseAsync(["node", "council-chat", target, "--engine", "mock"]),
    out: () => out,
  };
}

/** Absolute paths readdir() was invoked with since the last mockClear(). */
function readdirTargets(): readonly string[] {
  return vi
    .mocked(fs.readdir)
    .mock.calls.map((c) => c[0])
    .filter((a): a is string => typeof a === "string")
    .map((a) => path.resolve(a));
}

describe("panel chat — generic-member docs-warning slug traversal guard (#1103, A2)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
    vi.mocked(fs.readdir).mockClear();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("does not read or disclose an out-of-tree docs dir for a `..` traversal member slug", async () => {
    // Plant a file the traversal would resolve to, so an unguarded sink would
    // readdir it and echo its path + count. `../SECRET` from
    // experts/<slug>/docs escapes experts/ into <dataHome>/SECRET/docs.
    const secretDocs = path.join(env.dataHome, "SECRET", "docs");
    await fs.mkdir(secretDocs, { recursive: true });
    await fs.writeFile(path.join(secretDocs, "leak.txt"), "top secret", "utf-8");

    await writeInlinePanel(env.dataHome, "traversal-panel", inlineGenericMemberYaml("../SECRET"));

    const run = runPanel("traversal-panel");
    await run.parse();
    const out = run.out();

    // Disclosure: the resolved out-of-tree docs path must never be surfaced.
    expect(out).not.toContain(secretDocs);
    expect(out).not.toMatch(/1 document\(s\)/);
    // Boundary: readdir must never be invoked on the escaped directory.
    expect(readdirTargets()).not.toContain(path.resolve(secretDocs));
  });

  it("does not readdir outside the per-expert docs root for a deep traversal slug", async () => {
    const escaped = path.resolve(path.join(env.dataHome, "experts", "../../../../etc", "docs"));
    await writeInlinePanel(env.dataHome, "deep-panel", inlineGenericMemberYaml("../../../../etc"));

    const run = runPanel("deep-panel");
    await run.parse();

    expect(readdirTargets()).not.toContain(escaped);
    expect(run.out()).not.toContain(escaped);
  });

  it("skips the docs scan entirely for an absolute-path-like member slug", async () => {
    // path.join keeps this lexically INSIDE experts/, so only a slug-shape gate
    // (not a startsWith containment check) prevents the readdir.
    const joined = path.resolve(path.join(env.dataHome, "experts", "/etc/passwd", "docs"));
    await writeInlinePanel(env.dataHome, "abs-panel", inlineGenericMemberYaml("/etc/passwd"));

    const run = runPanel("abs-panel");
    await run.parse();

    expect(readdirTargets()).not.toContain(joined);
  });

  it("skips the docs scan entirely for a control-byte member slug", async () => {
    const slug = "panel-a\u0007"; // valid prefix + BEL — rejected by the slug gate
    const joined = path.resolve(path.join(env.dataHome, "experts", slug, "docs"));
    await writeInlinePanel(env.dataHome, "ctrl-panel", inlineGenericMemberYaml(slug));

    const run = runPanel("ctrl-panel");
    await run.parse();

    expect(readdirTargets()).not.toContain(joined);
  });

  it("still warns for a VALID generic member that has unindexed docs (behavior-preserving)", async () => {
    // Positive control: a well-formed slug must keep reading its own docs dir
    // and surfacing the identical #1103 warning.
    const docsDir = path.join(env.dataHome, "experts", "good-generic", "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "memo.md"), "# ignored by a generic expert", "utf-8");

    await writeInlinePanel(env.dataHome, "valid-panel", inlineGenericMemberYaml("good-generic"));

    const run = runPanel("valid-panel");
    await run.parse();
    const out = run.out();

    expect(out).toMatch(/\(good-generic\) is a generic expert/);
    expect(out).toMatch(/are NOT indexed and will be ignored/);
    expect(readdirTargets()).toContain(path.resolve(docsDir));
  });
});

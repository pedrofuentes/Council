import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExpertCommand, type ExpertCommandDeps } from "../../src/cli/commands/expert.js";
import { buildPanelCommand } from "../../src/cli/commands/panel.js";
import { buildTemplatesCommand } from "../../src/cli/commands/templates.js";
import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import type { MockEngineOptions } from "../../src/engine/mock/mock-engine.js";
import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  makeMockEngineFactory,
  openTestDb,
  pairTurnEventsByExpert,
  type E2EContext,
} from "./helpers.js";

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

interface ExpertListRow {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: string;
  readonly panels: readonly string[];
}

interface PanelListRow {
  readonly name: string;
  readonly description: string | null;
  readonly experts: readonly string[];
}

interface StoredPanelConfig {
  readonly template?: string;
  readonly mode?: string;
  readonly maxRounds?: number;
  readonly maxWords?: number;
  readonly engine?: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function expertCreateArgs(
  slug: string,
  overrides: {
    readonly name?: string;
    readonly role?: string;
    readonly expertise?: string;
    readonly stance?: string;
  } = {},
): readonly string[] {
  return [
    "create",
    "--slug",
    slug,
    "--name",
    overrides.name ?? `${slug} expert`,
    "--role",
    overrides.role ?? `${slug} role`,
    "--expertise",
    overrides.expertise ?? `${slug} evidence`,
    "--stance",
    overrides.stance ?? `${slug} stance`,
  ];
}

async function runExpertCommand(
  args: readonly string[],
  deps: ExpertCommandDeps = {},
): Promise<CommandOutput> {
  const output = captureOutput();
  const command = buildExpertCommand(output.write, output.writeError, deps);
  await command.parseAsync(["node", "council-expert", ...args]);
  return { stdout: output.stdout(), stderr: output.stderr() };
}

async function runPanelCommand(args: readonly string[]): Promise<CommandOutput> {
  const output = captureOutput();
  const command = buildPanelCommand(output.write, output.writeError);
  await command.parseAsync(["node", "council-panel", ...args]);
  return { stdout: output.stdout(), stderr: output.stderr() };
}

async function runTemplatesCommand(): Promise<CommandOutput> {
  const output = captureOutput();
  const command = buildTemplatesCommand(output.write);
  await command.parseAsync(["node", "council-templates"]);
  return { stdout: output.stdout(), stderr: output.stderr() };
}

async function runConveneCommand(
  args: readonly string[],
  engineOptions: MockEngineOptions = { responses: {} },
): Promise<CommandOutput> {
  const output = captureOutput();
  const command = buildConveneCommand({
    engineFactory: makeMockEngineFactory(engineOptions),
    write: output.write,
    writeError: output.writeError,
  });
  await command.parseAsync(["node", "council-convene", ...args]);
  return { stdout: output.stdout(), stderr: output.stderr() };
}

async function withEditor(editor: string, fn: () => Promise<void>): Promise<void> {
  const originalEditor = process.env["EDITOR"];
  process.env["EDITOR"] = editor;
  try {
    await fn();
  } finally {
    if (originalEditor === undefined) delete process.env["EDITOR"];
    else process.env["EDITOR"] = originalEditor;
  }
}

async function writeEditorStub(
  ctx: E2EContext,
  fileName: string,
  contents: string,
): Promise<string> {
  const stubPath = path.join(ctx.testHome, fileName);
  await fs.writeFile(stubPath, contents, "utf-8");
  return `node "${stubPath}"`;
}

async function readExpertLibraryRow(
  ctx: E2EContext,
  slug: string,
): Promise<
  | {
      readonly slug: string;
      readonly kind: string;
      readonly display_name: string;
      readonly yaml_path: string;
      readonly yaml_checksum: string;
    }
  | undefined
> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await db
      .selectFrom("expert_library")
      .select(["slug", "kind", "display_name", "yaml_path", "yaml_checksum"])
      .where("slug", "=", slug)
      .executeTakeFirst();
  } finally {
    await destroyTestDb(db);
  }
}

async function readPanelLibraryRow(
  ctx: E2EContext,
  name: string,
): Promise<
  | {
      readonly name: string;
      readonly description: string | null;
      readonly yaml_path: string;
      readonly yaml_checksum: string;
    }
  | undefined
> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await db
      .selectFrom("panel_library")
      .select(["name", "description", "yaml_path", "yaml_checksum"])
      .where("name", "=", name)
      .executeTakeFirst();
  } finally {
    await destroyTestDb(db);
  }
}

async function readPanelMembers(ctx: E2EContext, panelName: string): Promise<readonly string[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    const rows = await db
      .selectFrom("panel_members")
      .select(["expert_slug", "position"])
      .where("panel_name", "=", panelName)
      .orderBy("position", "asc")
      .execute();
    return rows.map((row) => row.expert_slug);
  } finally {
    await destroyTestDb(db);
  }
}

async function findRuntimePanelByTemplate(
  ctx: E2EContext,
  templateName: string,
): Promise<
  | {
      readonly id: string;
      readonly name: string;
      readonly topic: string | null;
      readonly configJson: string;
    }
  | undefined
> {
  const db = await openTestDb(ctx.testHome);
  try {
    const rows = await db
      .selectFrom("panels")
      .select(["id", "name", "topic", "config_json as configJson"])
      .orderBy("created_at", "desc")
      .execute();
    return rows.find((row) => {
      try {
        const config = JSON.parse(row.configJson) as StoredPanelConfig;
        return config.template === templateName;
      } catch (err) {
        throw new Error(
          `Malformed config_json for panel ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  } finally {
    await destroyTestDb(db);
  }
}

describe("expert/panel CRUD E2E", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  }, 30_000);

  it("expert create -> list -> inspect persists YAML and DB metadata", async () => {
    const created = await runExpertCommand(
      expertCreateArgs("architect", {
        name: "Architect Reviewer",
        role: "Platform architect",
        expertise: "distributed systems, cost controls",
        stance: "Evidence-first",
      }),
    );
    expect(created.stdout).toMatch(/created/i);
    expect(created.stdout).toContain("architect");

    const yamlPath = path.join(ctx.testDataHome, "experts", "architect.yaml");
    const yamlBody = await fs.readFile(yamlPath, "utf-8");
    expect(yamlBody).toContain("slug: architect");
    expect(yamlBody).toContain("Architect Reviewer");

    const expertRow = await readExpertLibraryRow(ctx, "architect");
    expect(expertRow?.display_name).toBe("Architect Reviewer");
    expect(expertRow?.yaml_path).toBe(yamlPath);

    const listed = await runExpertCommand(["list", "--format", "json"]);
    const experts = JSON.parse(listed.stdout) as readonly ExpertListRow[];
    expect(experts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "architect",
          displayName: "Architect Reviewer",
          panels: [],
        }),
      ]),
    );

    const inspected = await runExpertCommand(["inspect", "architect"]);
    expect(inspected.stdout).toContain("Expert: architect");
    expect(inspected.stdout).toContain("Architect Reviewer");
    expect(inspected.stdout).toContain("Platform architect");
    expect(inspected.stdout).toMatch(/architect\.yaml/);
  });

  it("expert edit updates YAML and DB metadata", async () => {
    await runExpertCommand(
      expertCreateArgs("ops-lead", {
        name: "Ops Lead",
        role: "Reliability lead",
        expertise: "incident response, observability",
        stance: "Empirical",
      }),
    );

    const editor = await writeEditorStub(
      ctx,
      "edit-expert.cjs",
      `const fs = require("fs");
const file = process.argv[2];
let body = fs.readFileSync(file, "utf-8");
body = body.replace(/^displayName: .*$/m, "displayName: Operations Lead");
body = body.replace(/^role: .*$/m, "role: Reliability architect");
fs.writeFileSync(file, body, "utf-8");`,
    );

    await withEditor(editor, async () => {
      const edited = await runExpertCommand(["edit", "ops-lead"]);
      expect(edited.stdout).toMatch(/saved|validated|✓/i);
    });

    const yamlPath = path.join(ctx.testDataHome, "experts", "ops-lead.yaml");
    const yamlBody = await fs.readFile(yamlPath, "utf-8");
    expect(yamlBody).toContain("displayName: Operations Lead");
    expect(yamlBody).toContain("role: Reliability architect");

    const expertRow = await readExpertLibraryRow(ctx, "ops-lead");
    expect(expertRow?.display_name).toBe("Operations Lead");
    expect(expertRow?.yaml_checksum).toBe(sha256(yamlBody));

    const inspected = await runExpertCommand(["inspect", "ops-lead"]);
    expect(inspected.stdout).toContain("Operations Lead");
    expect(inspected.stdout).toContain("Reliability architect");
  });

  it("expert delete removes an unreferenced expert from disk and DB", async () => {
    await runExpertCommand(expertCreateArgs("solo-expert"));

    const deleted = await runExpertCommand(["delete", "solo-expert", "--yes"]);
    expect(deleted.stdout).toMatch(/deleted/i);

    const yamlPath = path.join(ctx.testDataHome, "experts", "solo-expert.yaml");
    await expect(fs.access(yamlPath)).rejects.toThrow();
    await expect(readExpertLibraryRow(ctx, "solo-expert")).resolves.toBeUndefined();
  });

  it("expert delete guards against deleting an expert referenced by a panel", async () => {
    await runExpertCommand(expertCreateArgs("cto"));
    await runPanelCommand([
      "create",
      "leadership-review",
      "--experts",
      "cto",
      "--mode",
      "freeform",
      "--description",
      "Leadership review panel",
    ]);

    const output = captureOutput();
    const command = buildExpertCommand(output.write, output.writeError);
    await expect(command.parseAsync(["node", "council-expert", "delete", "cto"])).rejects.toThrow(
      /panel|force/i,
    );
    expect(output.stderr()).toMatch(/leadership-review/);
    expect(output.stderr()).toMatch(/--force/i);

    expect(await readExpertLibraryRow(ctx, "cto")).toBeDefined();
    expect(await readPanelMembers(ctx, "leadership-review")).toEqual(["cto"]);
  });

  it("expert delete --force removes the expert and clears panel membership", async () => {
    await runExpertCommand(expertCreateArgs("cto"));
    await runPanelCommand([
      "create",
      "force-review",
      "--experts",
      "cto",
      "--mode",
      "freeform",
      "--description",
      "Force-delete test panel",
    ]);

    const deleted = await runExpertCommand(["delete", "cto", "--force", "--yes"]);
    expect(deleted.stdout).toMatch(/deleted/i);
    expect(await readExpertLibraryRow(ctx, "cto")).toBeUndefined();
    expect(await readPanelMembers(ctx, "force-review")).toEqual([]);

    const inspected = await runPanelCommand(["inspect", "force-review"]);
    expect(inspected.stdout).toContain("Panel: force-review");
    expect(inspected.stdout).toContain("Members (0):");
  });

  it("panel create -> list -> inspect persists YAML and ordered membership", async () => {
    await runExpertCommand(expertCreateArgs("cto", { name: "CTO" }));
    await runExpertCommand(expertCreateArgs("pm", { name: "Product Manager" }));

    const created = await runPanelCommand([
      "create",
      "launch-council",
      "--experts",
      "cto,pm",
      "--mode",
      "freeform",
      "--description",
      "Launch readiness review",
    ]);
    expect(created.stdout).toMatch(/created/i);
    expect(created.stdout).toContain("launch-council");

    const yamlPath = path.join(ctx.testDataHome, "panels", "launch-council.yaml");
    const yamlBody = await fs.readFile(yamlPath, "utf-8");
    expect(yamlBody).toContain("name: launch-council");
    expect(yamlBody).toContain("Launch readiness review");
    expect(yamlBody).toContain("- cto");
    expect(yamlBody).toContain("- pm");

    const panelRow = await readPanelLibraryRow(ctx, "launch-council");
    expect(panelRow?.description).toBe("Launch readiness review");
    expect(panelRow?.yaml_path).toBe(yamlPath);
    expect(await readPanelMembers(ctx, "launch-council")).toEqual(["cto", "pm"]);

    const listed = await runPanelCommand(["list", "--format", "json"]);
    const panels = JSON.parse(listed.stdout) as readonly PanelListRow[];
    expect(panels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "launch-council",
          experts: ["cto", "pm"],
        }),
      ]),
    );

    const inspected = await runPanelCommand(["inspect", "launch-council"]);
    expect(inspected.stdout).toContain("Panel: launch-council");
    expect(inspected.stdout).toContain("Launch readiness review");
    expect(inspected.stdout).toContain("cto: CTO");
    expect(inspected.stdout).toContain("pm: Product Manager");
  });

  it("panel create rejects duplicate panel names", async () => {
    await runExpertCommand(expertCreateArgs("cto"));
    await runPanelCommand(["create", "duplicate-panel", "--experts", "cto"]);

    const output = captureOutput();
    const command = buildPanelCommand(output.write, output.writeError);
    await expect(
      command.parseAsync([
        "node",
        "council-panel",
        "create",
        "duplicate-panel",
        "--experts",
        "cto",
      ]),
    ).rejects.toThrow(/already exists/i);
    expect(output.stderr()).toMatch(/already exists/i);
  });

  it("templates list shows the built-in templates", async () => {
    const listed = await runTemplatesCommand();
    expect(listed.stdout).toContain("code-review");
    expect(listed.stdout).toContain("architecture-review");
    expect(listed.stdout).toContain("career-coaching");
    expect(listed.stdout).toContain("incident-postmortem");
    expect(listed.stdout).toContain("startup-validation");
  });

  it("first convene migrates built-in templates into the library", async () => {
    const convened = await runConveneCommand([
      "Should we tighten our deployment checks?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    const jsonLines = convened.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as { readonly kind: string; readonly expertSlug?: string });
    
    const kinds = jsonLines.map((line) => line.kind);
    
    // Contract-level assertions
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds).toContain("turn.start");
    expect(kinds).toContain("turn.end");
    expect(kinds).toContain("debate.end");
    expect(kinds[kinds.length - 1]).toBe("conclusion");
    
    // Verify each expert's turn.start is correctly paired with its own
    // turn.end. Pairing is by expertSlug identity (#637), not by assuming
    // the two events are positionally adjacent in the stream — so this
    // stays correct even if the engine's ordering guarantees change, while
    // still failing on a real dropped/duplicated/mismatched turn event.
    const turnEvents = jsonLines.filter((e) => e.kind === "turn.start" || e.kind === "turn.end");
    expect(turnEvents.length).toBeGreaterThan(0);
    const turnPairs = pairTurnEventsByExpert(turnEvents);
    expect(turnPairs).toHaveLength(turnEvents.length / 2);
    expect(turnPairs.map((pair) => pair.expertSlug).sort()).toEqual([
      "maintainer",
      "perf",
      "security",
      "senior",
    ]);

    const db = await openTestDb(ctx.testHome);
    try {
      const templates = await db
        .selectFrom("panel_library")
        .select("name")
        .orderBy("name", "asc")
        .execute();
      expect(templates.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "architecture-review",
          "career-coaching",
          "code-review",
          "incident-postmortem",
          "startup-validation",
        ]),
      );

      const codeReviewMembers = await db
        .selectFrom("panel_members")
        .select("expert_slug")
        .where("panel_name", "=", "code-review")
        .orderBy("position", "asc")
        .execute();
      expect(codeReviewMembers.length).toBeGreaterThan(0);
      const slugs = codeReviewMembers.map((m) => m.expert_slug);
      expect(slugs).toEqual(expect.arrayContaining(["senior", "security", "perf", "maintainer"]));

      const expertRows = await db.selectFrom("expert_library").select("slug").execute();
      expect(expertRows.length).toBeGreaterThan(0);
    } finally {
      await destroyTestDb(db);
    }

    await expect(
      fs.access(path.join(ctx.testDataHome, "panels", "code-review.yaml")),
    ).resolves.toBeUndefined();
    const expertFiles = await fs.readdir(path.join(ctx.testDataHome, "experts"));
    expect(expertFiles.some((file) => file.endsWith(".yaml"))).toBe(true);
  });

  it("convene resolves slug-based user library panels into persisted debates", async () => {
    await runExpertCommand(
      expertCreateArgs("cto", {
        name: "CTO Lens",
        role: "Architecture owner",
        expertise: "architecture, operability",
        stance: "Skeptical",
      }),
    );
    await runExpertCommand(
      expertCreateArgs("pm", {
        name: "PM Lens",
        role: "Product strategy lead",
        expertise: "user research, roadmap tradeoffs",
        stance: "Outcome-driven",
      }),
    );
    await runPanelCommand([
      "create",
      "product-council",
      "--experts",
      "cto,pm",
      "--mode",
      "freeform",
      "--description",
      "Product decision council",
    ]);

    const convened = await runConveneCommand([
      "Should we expand into enterprise self-serve?",
      "--template",
      "product-council",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);
    expect(convened.stderr).toMatch(/MOCK/i);
    
    // Contract-level assertions on JSON output
    const jsonLines = convened.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as { readonly kind: string });
    const kinds = jsonLines.map((line) => line.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds).toContain("debate.end");
    expect(kinds[kinds.length - 1]).toBe("conclusion");

    const runtimePanel = await findRuntimePanelByTemplate(ctx, "product-council");
    expect(runtimePanel?.topic).toBe("Should we expand into enterprise self-serve?");
    const config = JSON.parse(runtimePanel?.configJson ?? "{}") as StoredPanelConfig;
    expect(config.template).toBe("product-council");
    expect(config.engine).toBe("mock");

    const db = await openTestDb(ctx.testHome);
    try {
      const experts = await db
        .selectFrom("experts")
        .select(["slug", "display_name"])
        .where("panel_id", "=", runtimePanel?.id ?? "")
        .orderBy("slug", "asc")
        .execute();
      expect(experts).toEqual([
        { slug: "cto", display_name: "CTO Lens" },
        { slug: "pm", display_name: "PM Lens" },
      ]);

      const debate = await db
        .selectFrom("debates")
        .select(["id", "status"])
        .where("panel_id", "=", runtimePanel?.id ?? "")
        .executeTakeFirst();
      expect(debate?.status).toBe("completed");

      const turns = await db
        .selectFrom("turns")
        .select(["speaker_kind", "content"])
        .where("debate_id", "=", debate?.id ?? "")
        .orderBy("round", "asc")
        .orderBy("seq", "asc")
        .execute();
      expect(turns).toHaveLength(2);
      expect(turns.every((turn) => turn.speaker_kind === "expert")).toBe(true);
      expect(turns.every((turn) => turn.content.length > 0)).toBe(true);
    } finally {
      await destroyTestDb(db);
    }
  });
});

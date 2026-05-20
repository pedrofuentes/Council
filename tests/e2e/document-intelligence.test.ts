import * as fs from "node:fs/promises";
import * as path from "node:path";

import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExpertCommand, type ExpertCommandDeps } from "../../src/cli/commands/expert.js";
import { buildPanelCommand } from "../../src/cli/commands/panel.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../src/engine/index.js";
import {
  DocumentRepository,
  type ExpertDocument,
} from "../../src/memory/repositories/document-repository.js";
import { PanelDocumentRepository } from "../../src/memory/repositories/panel-document-repo.js";
import { ProfileRepository } from "../../src/memory/repositories/profile-repository.js";

import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  openTestDb,
  type E2EContext,
} from "./helpers.js";

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

class StubEngine implements CouncilEngine {
  readonly registered: ExpertSpec[] = [];
  readonly removed: string[] = [];
  readonly sends: { readonly expertId: string; readonly prompt: string }[] = [];
  readonly responses: string[];

  constructor(responses: readonly string[]) {
    this.responses = [...responses];
  }

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    // no-op
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    this.registered.push(spec);
  }

  async removeExpert(expertId: string): Promise<void> {
    this.removed.push(expertId);
  }

  async listModels(): Promise<readonly string[]> {
    return ["stub-model"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push({ expertId: options.expertId, prompt: options.prompt });
    const text = this.responses.shift() ?? "";
    const expertId = options.expertId;

    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      yield { kind: "message.delta", expertId, text };
      yield {
        kind: "message.complete",
        expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

function buildProfileJson(communicationStyle: string, epistemicStance: string): string {
  return JSON.stringify({
    communicationStyle,
    decisionPatterns: ["consult-data", "ship-incrementally"],
    biases: ["recency"],
    vocabulary: ["ship", "data"],
    epistemicStance,
  });
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

async function createPersonaExpert(slug = "boss"): Promise<void> {
  await runExpertCommand([
    "create",
    "--persona",
    "--slug",
    slug,
    "--name",
    "My Boss",
    "--role",
    "VP of Engineering",
    "--expertise",
    "calibration, planning",
    "--stance",
    "Outcome-driven",
    "--persona-description",
    "VP of Engineering I report to",
  ]);
}

async function createPanelWithExpert(
  panelName = "arch-review",
  expertSlug = "reviewer",
): Promise<void> {
  await runExpertCommand([
    "create",
    "--slug",
    expertSlug,
    "--name",
    "Architecture Reviewer",
    "--role",
    "Platform reviewer",
    "--expertise",
    "architecture, operations",
    "--stance",
    "Evidence-first",
  ]);

  await runPanelCommand([
    "create",
    panelName,
    "--experts",
    expertSlug,
    "--mode",
    "freeform",
    "--description",
    "Architecture review panel",
  ]);
}

async function writeExpertDoc(
  ctx: E2EContext,
  slug: string,
  filename: string,
  body: string,
): Promise<string> {
  const docsDir = path.join(ctx.testDataHome, "experts", slug, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  const filePath = path.join(docsDir, filename);
  await fs.writeFile(filePath, body, "utf-8");
  return filePath;
}

async function readExpertDocuments(
  ctx: E2EContext,
  slug: string,
): Promise<readonly ExpertDocument[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await new DocumentRepository(db).findByExpert(slug);
  } finally {
    await destroyTestDb(db);
  }
}

async function readProfile(ctx: E2EContext, slug: string) {
  const db = await openTestDb(ctx.testHome);
  try {
    return await new ProfileRepository(db).findBySlug(slug);
  } finally {
    await destroyTestDb(db);
  }
}

async function readFtsFilePaths(
  ctx: E2EContext,
  sourceType: "expert" | "panel",
  sourceSlug: string,
): Promise<readonly string[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    const result = await sql<{ file_path: string }>`
      SELECT file_path
      FROM document_index
      WHERE source_type = ${sourceType}
        AND source_slug = ${sourceSlug}
      ORDER BY file_path
    `.execute(db);
    return result.rows.map((row) => row.file_path);
  } finally {
    await destroyTestDb(db);
  }
}

async function readLinkedFolders(ctx: E2EContext, panelName: string): Promise<readonly string[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await new PanelDocumentRepository(db).getLinkedFolders(panelName);
  } finally {
    await destroyTestDb(db);
  }
}

describe.sequential("document intelligence e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  it("expert train indexes documents", async () => {
    await createPersonaExpert();
    const alphaPath = await writeExpertDoc(
      ctx,
      "boss",
      "alpha.md",
      "Alpha memo about hiring loops.",
    );
    const betaPath = await writeExpertDoc(
      ctx,
      "boss",
      "beta.md",
      "Beta memo about release readiness.",
    );

    const trained = await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () =>
        new StubEngine([buildProfileJson("Terse and direct.", "Empirical, updates on evidence.")]),
    });

    expect(trained.stdout).toContain("alpha.md");
    expect(trained.stdout).toContain("beta.md");
    expect(trained.stderr).toBe("");

    const docs = await readExpertDocuments(ctx, "boss");
    expect(docs).toHaveLength(2);
    expect(docs.map((doc) => doc.filename).sort()).toEqual(["alpha.md", "beta.md"]);
    expect(docs.every((doc) => doc.status === "processed")).toBe(true);

    const ftsPaths = await readFtsFilePaths(ctx, "expert", "boss");
    expect(ftsPaths).toEqual([alphaPath, betaPath].sort());

    const profile = await readProfile(ctx, "boss");
    expect(profile?.communicationStyle).toBe("Terse and direct.");
    expect(profile?.epistemicStance).toBe("Empirical, updates on evidence.");
    expect(profile?.documentCount).toBe(2);
  });

  it("expert docs lists indexed documents", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "alpha.md", "Alpha memo about roadmap planning.");
    await writeExpertDoc(ctx, "boss", "beta.md", "Beta memo about release planning.");

    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () =>
        new StubEngine([
          buildProfileJson("Clear and structured.", "Grounded in written evidence."),
        ]),
    });

    const listed = await runExpertCommand(["docs", "boss"]);

    expect(listed.stdout).toContain("filename");
    expect(listed.stdout).toContain("alpha.md");
    expect(listed.stdout).toContain("beta.md");
    expect(listed.stdout.toLowerCase()).toContain("processed");
  });

  it("expert train detects changes on re-run", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "alpha.md", "Initial memo about release gating.");

    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () =>
        new StubEngine([buildProfileJson("Direct.", "Weights evidence heavily.")]),
    });

    const before = await readExpertDocuments(ctx, "boss");
    const firstChecksum = before[0]?.checksum;
    expect(firstChecksum).toBeDefined();

    await writeExpertDoc(
      ctx,
      "boss",
      "alpha.md",
      "Updated memo about release gating with an extra section on rollback plans.",
    );

    const retrained = await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () =>
        new StubEngine([
          buildProfileJson("Direct and concise.", "Revises beliefs when new evidence lands."),
        ]),
    });

    expect(retrained.stdout).toContain("alpha.md");
    expect(retrained.stdout).toContain("0 unchanged");

    const after = await readExpertDocuments(ctx, "boss");
    expect(after).toHaveLength(1);
    expect(after[0]?.checksum).not.toBe(firstChecksum);
    expect(after[0]?.status).toBe("processed");

    const ftsPaths = await readFtsFilePaths(ctx, "expert", "boss");
    expect(ftsPaths).toHaveLength(1);
    expect(ftsPaths[0]).toContain("alpha.md");
  });

  it("expert retrain clears and rebuilds", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "alpha.md", "Steady-state memo about product bets.");

    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () =>
        new StubEngine([buildProfileJson("Measured and calm.", "Starts with prior experience.")]),
    });

    const beforeDocs = await readExpertDocuments(ctx, "boss");
    const beforeProcessedAt = beforeDocs[0]?.processedAt;
    const beforeProfile = await readProfile(ctx, "boss");
    expect(beforeProfile?.communicationStyle).toBe("Measured and calm.");

    const retrained = await runExpertCommand(["train", "boss", "--retrain", "--engine", "mock"], {
      engineFactory: () =>
        new StubEngine([
          buildProfileJson("Rebuilt from scratch.", "Re-anchors on the refreshed corpus."),
        ]),
    });

    expect(retrained.stdout.toLowerCase()).toMatch(/retrain|cleared profile/);
    expect(retrained.stdout).toContain("alpha.md");

    const afterDocs = await readExpertDocuments(ctx, "boss");
    expect(afterDocs).toHaveLength(1);
    expect(afterDocs[0]?.status).toBe("processed");
    expect(afterDocs[0]?.processedAt).not.toBe(beforeProcessedAt);

    const afterProfile = await readProfile(ctx, "boss");
    expect(afterProfile?.communicationStyle).toBe("Rebuilt from scratch.");
    expect(afterProfile?.documentCount).toBe(1);

    const ftsPaths = await readFtsFilePaths(ctx, "expert", "boss");
    expect(ftsPaths).toHaveLength(1);
  });

  it("panel docs link and list", async () => {
    await createPanelWithExpert();
    const linkedDir = path.join(ctx.testHome, "linked-docs");
    await fs.mkdir(linkedDir, { recursive: true });
    await fs.writeFile(path.join(linkedDir, "a.md"), "# A\nhello world", "utf-8");
    await fs.writeFile(path.join(linkedDir, "b.md"), "# B\nrelease notes", "utf-8");

    const linked = await runPanelCommand(["docs", "link", "arch-review", "--path", linkedDir, "--yes"]);
    expect(linked.stdout).toContain(path.basename(linkedDir));
    expect(linked.stdout).toContain("2 documents found");

    const listed = await runPanelCommand(["docs", "list", "arch-review"]);
    expect(listed.stdout).toContain("Linked folders (1):");
    expect(listed.stdout).toContain(path.basename(linkedDir));

    const folders = await readLinkedFolders(ctx, "arch-review");
    expect(folders).toEqual([linkedDir]);
  });

  it("panel docs unlink removes folder", async () => {
    await createPanelWithExpert();
    const linkedDir = path.join(ctx.testHome, "linked-docs-to-remove");
    await fs.mkdir(linkedDir, { recursive: true });
    await fs.writeFile(path.join(linkedDir, "a.md"), "# A\ncleanup target", "utf-8");

    await runPanelCommand(["docs", "link", "arch-review", "--path", linkedDir, "--yes"]);

    const unlinked = await runPanelCommand(["docs", "unlink", "arch-review", "--path", linkedDir]);
    expect(unlinked.stdout.toLowerCase()).toContain("unlinked");

    const listed = await runPanelCommand(["docs", "list", "arch-review"]);
    expect(listed.stdout.toLowerCase()).toMatch(/no documents found/);
    expect(listed.stdout).not.toContain(path.basename(linkedDir));

    const folders = await readLinkedFolders(ctx, "arch-review");
    expect(folders).toEqual([]);
  });
});

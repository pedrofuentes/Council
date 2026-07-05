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
import {
  PanelDocumentRepository,
  type PanelDocument,
} from "../../src/memory/repositories/panel-document-repo.js";
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

async function readPanelDocuments(
  ctx: E2EContext,
  panelName: string,
): Promise<readonly PanelDocument[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await new PanelDocumentRepository(db).listDocuments(panelName);
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
  }, 30_000);

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
    expect(retrained.stdout).toContain("0 already up to date");

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

  it("expert docs --remove persists across train --retrain", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "keep.md", "Keeper memo about roadmap planning.");
    await writeExpertDoc(ctx, "boss", "remove-me.md", "Removable memo about a legacy system.");

    // Initial train indexes both documents.
    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () => new StubEngine([buildProfileJson("Terse.", "Empirical.")]),
    });

    const activeAfterTrain = (await readExpertDocuments(ctx, "boss"))
      .filter((d) => d.status !== "removed")
      .map((d) => d.filename)
      .sort();
    expect(activeAfterTrain).toEqual(["keep.md", "remove-me.md"]);

    // Un-index one document via `expert docs --remove` (the file stays on disk).
    const removed = await runExpertCommand(["docs", "boss", "--remove", "remove-me.md"]);
    expect(removed.stdout).toContain("removed from index");

    const activeAfterRemove = (await readExpertDocuments(ctx, "boss"))
      .filter((d) => d.status !== "removed")
      .map((d) => d.filename);
    expect(activeAfterRemove).toEqual(["keep.md"]);

    // Retrain — the removed file (still on disk) must NOT be resurrected.
    const retrained = await runExpertCommand(["train", "boss", "--retrain", "--engine", "mock"], {
      engineFactory: () => new StubEngine([buildProfileJson("Rebuilt.", "Re-anchored.")]),
    });
    expect(retrained.stdout).not.toContain("remove-me.md");

    const activeAfterRetrain = (await readExpertDocuments(ctx, "boss"))
      .filter((d) => d.status !== "removed")
      .map((d) => d.filename);
    expect(activeAfterRetrain).toEqual(["keep.md"]);
    expect(activeAfterRetrain).not.toContain("remove-me.md");

    // The removed document must not reappear in the FTS index either.
    const ftsPaths = await readFtsFilePaths(ctx, "expert", "boss");
    expect(ftsPaths.some((p) => p.includes("remove-me.md"))).toBe(false);
    expect(ftsPaths.some((p) => p.includes("keep.md"))).toBe(true);
  });

  it("expert train --file re-adds a previously removed document", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "keep.md", "Keeper memo about roadmap planning.");
    await writeExpertDoc(ctx, "boss", "readd.md", "Re-addable memo about a project.");

    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () => new StubEngine([buildProfileJson("Terse.", "Empirical.")]),
    });

    await runExpertCommand(["docs", "boss", "--remove", "readd.md"]);
    expect(
      (await readExpertDocuments(ctx, "boss"))
        .filter((d) => d.status !== "removed")
        .map((d) => d.filename),
    ).toEqual(["keep.md"]);

    // Explicitly re-add the same filename via `--file`: exclusion is not a
    // permanent blacklist against an explicit re-add.
    const source = path.join(ctx.testHome, "reimport");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "readd.md"),
      "Re-added content about the project.",
      "utf-8",
    );

    await runExpertCommand(
      ["train", "boss", "--file", path.join(source, "readd.md"), "--engine", "mock"],
      { engineFactory: () => new StubEngine([buildProfileJson("Refreshed.", "Updated.")]) },
    );

    const activeAfterReadd = (await readExpertDocuments(ctx, "boss"))
      .filter((d) => d.status !== "removed")
      .map((d) => d.filename)
      .sort();
    expect(activeAfterReadd).toEqual(["keep.md", "readd.md"]);
  });

  it("expert docs --remove maintains consistency when library.update fails (read-only YAML)", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "keep.md", "Keeper memo about roadmap planning.");
    await writeExpertDoc(ctx, "boss", "will-fail.md", "Memo that will fail to remove.");

    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () => new StubEngine([buildProfileJson("Terse.", "Empirical.")]),
    });

    // Make the expert's YAML file read-only to force library.update to fail
    const yamlPath = path.join(ctx.testDataHome, "experts", "boss.yaml");
    await fs.chmod(yamlPath, 0o444);

    // Attempt to remove - should fail with clear error, and NOT leave document in "removed" state
    await expect(runExpertCommand(["docs", "boss", "--remove", "will-fail.md"])).rejects.toThrow();

    // After failure, document must still be active (not left in inconsistent "removed" state)
    const documentsAfterFailed = (await readExpertDocuments(ctx, "boss"))
      .filter((d) => d.status !== "removed")
      .map((d) => d.filename)
      .sort();
    expect(documentsAfterFailed).toEqual(["keep.md", "will-fail.md"]);

    // Clean up: restore write permission
    await fs.chmod(yamlPath, 0o644);
  });

  it("expert train --file provides contextual error when excludedDocs update fails (read-only YAML)", async () => {
    await createPersonaExpert();
    await writeExpertDoc(ctx, "boss", "keep.md", "Keeper memo about roadmap planning.");
    await writeExpertDoc(ctx, "boss", "readd.md", "Re-addable memo about a project.");

    await runExpertCommand(["train", "boss", "--engine", "mock"], {
      engineFactory: () => new StubEngine([buildProfileJson("Terse.", "Empirical.")]),
    });

    // Remove the document so it goes into excludedDocs
    await runExpertCommand(["docs", "boss", "--remove", "readd.md"]);

    // Make YAML read-only so excludedDocs pruning will fail
    const yamlPath = path.join(ctx.testDataHome, "experts", "boss.yaml");
    await fs.chmod(yamlPath, 0o444);

    // Re-add document - the commit succeeds, but excludedDocs pruning should fail with contextual error
    const source = path.join(ctx.testHome, "reimport");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "readd.md"), "Re-added content.", "utf-8");

    // Assert on DISTINCTIVE wording from #2400 fix (not just "boss" from filesystem path).
    // Pre-fix: raw EACCES mentions "boss.yaml" but NOT these operational phrases.
    // Post-fix: error includes contextual guidance about what succeeded and how to recover.
    await expect(
      runExpertCommand(
        ["train", "boss", "--file", path.join(source, "readd.md"), "--engine", "mock"],
        {
          engineFactory: () => new StubEngine([buildProfileJson("Refreshed.", "Updated.")]),
        },
      ),
    ).rejects.toThrow(/after re-adding documents.*successfully committed.*exclusion list could not be pruned/is);

    // Clean up
    await fs.chmod(yamlPath, 0o644);
  });

  it("panel docs link and list", async () => {
    await createPanelWithExpert();
    const linkedDir = path.join(ctx.testHome, "linked-docs");
    await fs.mkdir(linkedDir, { recursive: true });
    await fs.writeFile(path.join(linkedDir, "a.md"), "# A\nhello world", "utf-8");
    await fs.writeFile(path.join(linkedDir, "b.md"), "# B\nrelease notes", "utf-8");

    const linked = await runPanelCommand([
      "docs",
      "link",
      "arch-review",
      "--path",
      linkedDir,
      "--yes",
    ]);
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

  it("panel docs unlink prunes indexed documents from the database", async () => {
    await createPanelWithExpert();
    const linkedDir = path.join(ctx.testHome, "linked-docs-indexed");
    await fs.mkdir(linkedDir, { recursive: true });
    await fs.writeFile(path.join(linkedDir, "a.md"), "# A\nindexed cleanup target", "utf-8");
    await fs.writeFile(path.join(linkedDir, "b.md"), "# B\nindexed second target", "utf-8");

    await runPanelCommand(["docs", "link", "arch-review", "--path", linkedDir, "--yes"]);

    // Trigger indexing so panel_documents rows are created for the linked folder.
    await runPanelCommand(["docs", "list", "arch-review", "--refresh"]);

    const docsBefore = await readPanelDocuments(ctx, "arch-review");
    const indexedBefore = docsBefore.filter(
      (d) => d.filePath.startsWith(linkedDir + "/") || d.filePath.startsWith(linkedDir + "\\"),
    );
    expect(indexedBefore).toHaveLength(2);

    const unlinked = await runPanelCommand(["docs", "unlink", "arch-review", "--path", linkedDir]);
    expect(unlinked.stdout.toLowerCase()).toContain("unlinked");

    const folders = await readLinkedFolders(ctx, "arch-review");
    expect(folders).toEqual([]);

    const docsAfter = await readPanelDocuments(ctx, "arch-review");
    const indexedAfter = docsAfter.filter(
      (d) => d.filePath.startsWith(linkedDir + "/") || d.filePath.startsWith(linkedDir + "\\"),
    );
    expect(indexedAfter).toHaveLength(0);
  });
});

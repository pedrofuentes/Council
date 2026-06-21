/**
 * Tests for `council export <panel> --format share` (T-growth-6).
 *
 * The `share` format renders a polished, launch-ready markdown document
 * with clearly labelled sections in a fixed order:
 *   Title → Prompt → Panel roster → Key Disagreements → Recommendation
 *   → Next Actions → Transcript.
 *
 * It is a PURE projection of the persisted session — no engine/LLM call.
 * Synthesis-derived sections (disagreements, recommendation, next actions)
 * come from a persisted moderator synthesis turn. When that synthesis was
 * never recorded, each such section prints an honest "Not recorded"
 * placeholder rather than fabricating a conclusion.
 *
 * RED at this commit: "share" is not yet an allowed `--format` value.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExportCommand, EXPORT_FORMATS } from "../../../../src/cli/commands/export.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

const SYNTHESIS_JSON = JSON.stringify({
  tensions: [
    "Speed-to-market versus security hardening before launch",
    "Feature-flag rollout versus a full public launch",
  ],
  recommendation: "Ship behind a feature flag after completing the auth checklist.",
  nextActions: [
    "Finish the auth checklist",
    "Configure the launch feature flag",
    "Schedule a phased rollout",
  ],
});

/** Seed a panel whose latest debate INCLUDES a moderator synthesis turn. */
async function seedConcludedPanel(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "share-concluded",
      topic: "Should we ship the MVP?",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await expertRepo.create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Should we ship the MVP?",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO position: ship now to get user feedback fast.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM position: hold two weeks for the auth flow.",
    });
    // Persisted moderator synthesis turn — the recorded "conclusion".
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "moderator",
      expertId: null,
      content: SYNTHESIS_JSON,
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

/** Seed a panel whose debate has NO synthesis turn (conclude never run). */
async function seedUnconcludedPanel(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "share-unconcluded",
      topic: "Adopt a monorepo?",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const arch = await expertRepo.create({
      panelId: panel.id,
      slug: "architect",
      displayName: "Architect",
      model: "claude-sonnet-4",
      systemMessage: "You are a software architect.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Should the team adopt a monorepo?",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: arch.id,
      content: "Architect: a monorepo simplifies cross-package refactors.",
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

function captureExport(): { deps: { write: (s: string) => void }; read: () => string } {
  let captured = "";
  return {
    deps: {
      write: (s: string) => {
        captured += s;
      },
    },
    read: () => captured,
  };
}

describe("council export --format share", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-export-share-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("exposes 'share' as an allowed export format", () => {
    expect(EXPORT_FORMATS).toContain("share");
    const cmd = buildExportCommand();
    const formatOption = cmd.options.find((o) => o.long === "--format");
    expect(formatOption?.argChoices).toContain("share");
  });

  it("renders all share sections in the required order", async () => {
    const seed = await seedConcludedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    const titleIdx = out.indexOf("# Should we ship the MVP?");
    const promptIdx = out.indexOf("## Prompt");
    const panelIdx = out.indexOf("## Panel");
    const tensionsIdx = out.search(/## Key Disagreements/i);
    const recIdx = out.search(/## Recommendation/i);
    const actionsIdx = out.search(/## Next Actions/i);
    const transcriptIdx = out.indexOf("## Transcript");

    for (const idx of [
      titleIdx,
      promptIdx,
      panelIdx,
      tensionsIdx,
      recIdx,
      actionsIdx,
      transcriptIdx,
    ]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(titleIdx).toBeLessThan(promptIdx);
    expect(promptIdx).toBeLessThan(panelIdx);
    expect(panelIdx).toBeLessThan(tensionsIdx);
    expect(tensionsIdx).toBeLessThan(recIdx);
    expect(recIdx).toBeLessThan(actionsIdx);
    expect(actionsIdx).toBeLessThan(transcriptIdx);
  });

  it("renders the panel roster with each expert and model", async () => {
    const seed = await seedConcludedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    expect(out).toContain("CTO");
    expect(out).toContain("PM");
    expect(out).toContain("cto");
    expect(out).toContain("pm");
    expect(out).toContain("claude-sonnet-4");
  });

  it("populates synthesis sections from a recorded moderator synthesis turn", async () => {
    const seed = await seedConcludedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    // Recorded tensions, recommendation and next actions appear verbatim.
    expect(out).toContain("Speed-to-market versus security hardening before launch");
    expect(out).toContain("Ship behind a feature flag after completing the auth checklist.");
    expect(out).toContain("Finish the auth checklist");

    // The structured synthesis is parsed, NOT dumped as raw JSON.
    expect(out).not.toContain('"tensions"');
    expect(out).not.toContain('"recommendation"');
    expect(out).not.toContain('"nextActions"');

    // No "Not recorded" placeholder when a synthesis exists.
    expect(out).not.toMatch(/Not recorded/i);

    // The synthesis turn is surfaced in its sections, not in the transcript.
    expect(out).toContain("## Transcript");
    expect(out).toContain("ship now to get user feedback fast");
  });

  it("prints honest placeholders (never fabricates) when no synthesis was recorded", async () => {
    const seed = await seedUnconcludedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    // Title / prompt / roster / transcript still render from persisted data.
    expect(out).toContain("# Adopt a monorepo?");
    expect(out).toContain("Should the team adopt a monorepo?");
    expect(out).toContain("Architect");
    expect(out).toContain("a monorepo simplifies cross-package refactors");

    // Each synthesis-derived section honestly reports missing data and
    // points the user at `council conclude`.
    const tensionsBlock = out.slice(
      out.search(/## Key Disagreements/i),
      out.search(/## Recommendation/i),
    );
    const recBlock = out.slice(out.search(/## Recommendation/i), out.search(/## Next Actions/i));
    const actionsBlock = out.slice(out.search(/## Next Actions/i), out.indexOf("## Transcript"));

    for (const block of [tensionsBlock, recBlock, actionsBlock]) {
      expect(block).toMatch(/Not recorded/i);
      expect(block).toContain("council conclude");
    }
  });

  it("is deterministic for identical input", async () => {
    const seed = await seedConcludedPanel(testHome);

    const first = captureExport();
    await buildExportCommand(first.deps).parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "share",
    ]);

    const second = captureExport();
    await buildExportCommand(second.deps).parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "share",
    ]);

    expect(first.read()).toBe(second.read());
  });

  it("writes share output to a file when --output is given", async () => {
    const seed = await seedConcludedPanel(testHome);
    const outPath = path.join(testHome, "share.md");
    const cmd = buildExportCommand({ write: () => undefined, writeError: () => undefined });
    await cmd.parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "share",
      "--output",
      outPath,
    ]);
    const fileContent = await fs.readFile(outPath, "utf8");
    expect(fileContent).toContain("# Should we ship the MVP?");
    expect(fileContent).toContain("## Recommendation");
    expect(fileContent).toContain(
      "Ship behind a feature flag after completing the auth checklist.",
    );
  });

  it("does NOT alter the markdown format output (non-breaking)", async () => {
    const seed = await seedConcludedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);
    const out = cap.read();

    // Share-only section headers must not leak into markdown.
    expect(out).not.toMatch(/## Key Disagreements/i);
    expect(out).not.toMatch(/## Next Actions/i);
    expect(out).not.toMatch(/Not recorded — run/i);
  });
});

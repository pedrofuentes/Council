/**
 * Tests for `council export <panel> --format share` (T-growth-6).
 *
 * The `share` format renders a polished, launch-ready markdown document
 * with clearly labelled sections in a fixed order:
 *   Title → Prompt → Panel roster → Panel Positions → Recommendation
 *   → Transcript.
 *
 * It is a PURE projection of the persisted session — no engine/LLM call.
 * Council persists only expert/human turns (see `src/memory/persister.ts`)
 * and `council conclude` prints its synthesis to stdout WITHOUT persisting
 * it. So `share` cannot include a synthesized recommendation: the
 * "Panel Positions" section surfaces each panellist's most recent REAL
 * recorded turn, and the "Recommendation" section is honest about the
 * missing synthesis — it points at `council conclude` (whose stdout the
 * user can copy in) rather than implying the export will be populated.
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

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const BIDI_OVERRIDE = "\u202E";
const ZERO_WIDTH_SPACE = "\u200B";

function expectNoTerminalControls(out: string): void {
  expect(out).not.toContain(ESC);
  expect(out).not.toContain(BEL);
  expect(out).not.toContain(C1_CSI);
  expect(out).not.toContain(BIDI_OVERRIDE);
  expect(out).not.toContain(ZERO_WIDTH_SPACE);
}

/**
 * Seed a realistic completed panel: two experts (CTO, PM) each speak an
 * opening turn (round 0) and a closing turn (round 1). NO moderator turn
 * is persisted — Council never persists one (the persister only writes
 * expert/human turns), so this mirrors what real panels actually store.
 */
async function seedDebatedPanel(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "share-debated",
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
    // Round 0 — opening positions.
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO opening: ship the MVP now to learn from real users.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM opening: hold two weeks to finish the auth flow.",
    });
    // Round 1 — closing positions (each expert's most recent turn).
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO closing: ship behind a feature flag once the auth checklist is done.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM closing: agreed, provided the auth checklist lands first.",
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

async function seedUnsafeSharePanel(
  testHome: string,
): Promise<{ panelName: string; readonly preservedBody: string }> {
  const preservedBody = "Keep **markdown** and unicode Ω 🎉\nKeep this second line.";
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "share-sanitize",
      topic: `Topic ${ESC}[31mred${ESC}[0m${ZERO_WIDTH_SPACE}\nwrapped${BIDI_OVERRIDE}`,
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const expert = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: `C${ESC}]8;;https://evil.example${BEL}TO${BEL}${BIDI_OVERRIDE}`,
      model: `claude${C1_CSI}31m-sonnet-4`,
      systemMessage: "You are a CTO.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: `Prompt ${ESC}[2Jwith${ZERO_WIDTH_SPACE} controls`,
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: expert.id,
      content: `${ESC}]0;pwnd${BEL}Latest ${BIDI_OVERRIDE}position\n${preservedBody}\nDone${BEL}`,
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name, preservedBody };
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
    const seed = await seedDebatedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    const titleIdx = out.indexOf("# Should we ship the MVP?");
    const promptIdx = out.indexOf("## Prompt");
    const panelIdx = out.indexOf("## Panel");
    const positionsIdx = out.search(/## Panel Positions/i);
    const recIdx = out.search(/## Recommendation/i);
    const transcriptIdx = out.indexOf("## Transcript");

    for (const idx of [titleIdx, promptIdx, panelIdx, positionsIdx, recIdx, transcriptIdx]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(titleIdx).toBeLessThan(promptIdx);
    expect(promptIdx).toBeLessThan(panelIdx);
    expect(panelIdx).toBeLessThan(positionsIdx);
    expect(positionsIdx).toBeLessThan(recIdx);
    expect(recIdx).toBeLessThan(transcriptIdx);
  });

  it("renders the panel roster with each expert and model", async () => {
    const seed = await seedDebatedPanel(testHome);
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

  it("strips terminal controls from share output while preserving markdown, unicode, and transcript newlines", async () => {
    const seed = await seedUnsafeSharePanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    expectNoTerminalControls(out);
    expect(out).toContain("# Topic red wrapped");
    expect(out).toContain("- **CTO** (`cto`) — claude31m-sonnet-4");
    expect(out).toContain("### CTO");
    expect(out).toContain("> Keep **markdown** and unicode Ω 🎉");
    expect(out).toContain("> Keep this second line.");
    expect(out).toContain("`council export share-sanitize --format share`");
  });

  it("surfaces each expert's latest recorded position from real turns (not a moderator turn)", async () => {
    const seed = await seedDebatedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    expect(out).toContain("## Panel Positions");

    const positionsBlock = out.slice(
      out.search(/## Panel Positions/i),
      out.search(/## Recommendation/i),
    );
    // Positions surface each expert's MOST RECENT (closing) turn.
    expect(positionsBlock).toContain(
      "CTO closing: ship behind a feature flag once the auth checklist is done.",
    );
    expect(positionsBlock).toContain(
      "PM closing: agreed, provided the auth checklist lands first.",
    );
    // The opening turns belong to the transcript, not the positions summary.
    expect(positionsBlock).not.toContain("CTO opening");

    const transcriptBlock = out.slice(out.indexOf("## Transcript"));
    expect(transcriptBlock).toContain("CTO opening: ship the MVP now to learn from real users.");

    // Never fabricates a synthesis: no "Not recorded" placeholder and no raw
    // JSON dumped from a (non-existent) moderator turn.
    expect(out).not.toMatch(/Not recorded/i);
    expect(out).not.toContain('"tensions"');
    expect(out).not.toContain('"recommendation"');
    expect(out).not.toContain('"nextActions"');
  });

  it("gives an honest recommendation pointer, never false 'run conclude to populate' guidance", async () => {
    const seed = await seedDebatedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "share"]);
    const out = cap.read();

    const recBlock = out.slice(out.search(/## Recommendation/i), out.indexOf("## Transcript"));

    // Honest, accurate pointer: conclude prints to stdout for the user to copy in.
    expect(recBlock).toContain("council conclude share-debated");
    expect(recBlock).toMatch(/stdout/i);
    expect(recBlock).toMatch(/copy/i);

    // The old FALSE guidance must be gone: nothing may claim that running
    // conclude will populate / synthesize / derive these export sections.
    expect(out).not.toMatch(/to populate/i);
    expect(out).not.toMatch(/run `council conclude` first/i);
    expect(out).not.toContain("synthesize the panel's disagreements");
    expect(out).not.toContain("derive recommended next actions");
  });

  it("is deterministic for identical input", async () => {
    const seed = await seedDebatedPanel(testHome);

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
    const seed = await seedDebatedPanel(testHome);
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
    expect(fileContent).toContain("## Panel Positions");
    expect(fileContent).toContain("## Recommendation");
    expect(fileContent).toContain(
      "CTO closing: ship behind a feature flag once the auth checklist is done.",
    );
  });

  it("does NOT alter the markdown format output (non-breaking)", async () => {
    const seed = await seedDebatedPanel(testHome);
    const cap = captureExport();
    const cmd = buildExportCommand(cap.deps);
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);
    const out = cap.read();

    // Share-only sections and guidance must not leak into markdown.
    expect(out).not.toMatch(/## Panel Positions/i);
    expect(out).not.toMatch(/## Recommendation/i);
    expect(out).not.toMatch(/Not recorded/i);
  });
});

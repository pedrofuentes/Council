/**
 * Tests for `council export <panel> --format md|json|adr [--output <path>]`
 * (ROADMAP §3.6).
 *
 * RED at this commit: src/cli/commands/export.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildExportCommand,
  resolveOutputPath,
  writeExportArtifact,
} from "../../../../src/cli/commands/export.js";
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

async function seedPanelWithDebate(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-test",
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
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO synthesis: launch behind a feature flag now.",
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

async function seedPanelWithUnsafeDebate(
  testHome: string,
): Promise<{ panelName: string; readonly preservedBody: string }> {
  const preservedBody = "Legit **markdown** café 🎉\nSecond line ≥ baseline";
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-sanitize",
      topic: `Ship ${ESC}[31mred${ESC}[0m${BIDI_OVERRIDE}${ZERO_WIDTH_SPACE}\nnow?`,
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
      prompt: `Prompt ${ESC}[2J${ZERO_WIDTH_SPACE}with controls`,
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: expert.id,
      content: `${ESC}]0;pwnd${BEL}Opening ${BIDI_OVERRIDE}position\n${preservedBody}\nDone${BEL}`,
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

async function seedPanelWithUnsafeFallbackSpeaker(
  testHome: string,
): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "export-unsafe-speaker",
      topic: "Speaker fallback safety",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Speaker fallback safety prompt",
      moderator: "round-robin",
    });
    await db
      .insertInto("turns")
      .values({
        id: "turn-unsafe-speaker",
        debate_id: debate.id,
        round: 0,
        seq: 0,
        speaker_kind: `moderator${ESC}]8;;https://evil.example${BEL}${C1_CSI}31m${BIDI_OVERRIDE}`,
        expert_id: null,
        content: "Fallback speaker content.",
        tokens_in: null,
        tokens_out: null,
        latency_ms: null,
        created_at: new Date().toISOString(),
      })
      .execute();
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithUnsafeLineBreakContent(
  testHome: string,
  content: string,
): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "export-unsafe-line-break",
      topic: "Line break safety",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Line break safety prompt",
      moderator: "round-robin",
    });
    const expert = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: expert.id,
      content,
    });
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithAdrInjectionContent(
  testHome: string,
  maliciousContent: string,
): Promise<{ panelName: string }> {
  // One expert with TWO turns → turns.length (2) > expertContribs (1), so the
  // ADR Discussion renders the "Full transcript" list branch (the sink for
  // issue #1475). The malicious multi-line payload is the second turn.
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "export-adr-injection",
      topic: "ADR discussion injection safety",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const expert = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "ADR discussion injection safety prompt",
      moderator: "round-robin",
    });
    const turnRepo = new TurnRepository(db);
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: expert.id,
      content: "Benign opening statement.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: expert.id,
      content: maliciousContent,
    });
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithUnsafeName(testHome: string): Promise<{ panelName: string }> {
  // The panel NAME itself carries terminal-escape, line-break and C1 control
  // chars. The export "Next:" hint echoes the resolved name and must sanitize
  // it to a single control-free line — see issue #1476.
  const name = `boardroom${ESC}[31m\r\nInjected${BEL}${C1_CSI}31m${BIDI_OVERRIDE}x`;
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name,
      topic: "Panel name sanitization safety",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const expert = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Panel name sanitization prompt",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: expert.id,
      content: "Opening statement.",
    });
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithUnicodeDebate(
  testHome: string,
): Promise<{ panelName: string; readonly unicodeSnippet: string }> {
  const unicodeSnippet = "Roadmap — ship 2× faster ≥ baseline 🎉";
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-unicode",
      topic: unicodeSnippet,
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO 🎯",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: unicodeSnippet,
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: `CTO position: ${unicodeSnippet}`,
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name, unicodeSnippet };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithMultipleDebates(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "export-multi-debate",
      topic: "Panel topic metadata",
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

    const sharedStartedAt = "2026-01-01T00:00:00.000Z";
    await db
      .insertInto("debates")
      .values([
        {
          id: "debate-c-original",
          panel_id: panel.id,
          prompt: "Original first debate prompt",
          status: "completed",
          moderator: "round-robin",
          started_at: sharedStartedAt,
          ended_at: "2026-01-01T00:01:00.000Z",
          cost_estimate: null,
        },
        {
          id: "debate-b-substantive",
          panel_id: panel.id,
          prompt: "Substantive follow-up debate prompt",
          status: "completed",
          moderator: "round-robin",
          started_at: sharedStartedAt,
          ended_at: "2026-01-01T00:02:00.000Z",
          cost_estimate: null,
        },
        {
          id: "debate-a-latest",
          panel_id: panel.id,
          prompt: "Latest but less substantive prompt",
          status: "completed",
          moderator: "round-robin",
          started_at: sharedStartedAt,
          ended_at: "2026-01-01T00:03:00.000Z",
          cost_estimate: null,
        },
      ])
      .execute();
    const firstDebate = { id: "debate-c-original" };
    await turnRepo.create({
      debateId: firstDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "First debate opening note.",
    });
    const substantiveDebate = { id: "debate-b-substantive" };
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO analysis: shipping behind a feature flag balances risk.",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM analysis: auth checklist must be complete first.",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO conclusion: ship behind a feature flag after checklist.",
    });
    await turnRepo.create({
      debateId: substantiveDebate.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM conclusion: agree to phased launch after checklist.",
    });
    const latestShortDebate = { id: "debate-a-latest" };
    await turnRepo.create({
      debateId: latestShortDebate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: pm.id,
      content: "Latest short debate note.",
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

async function seedPanelWithShortTurns(testHome: string): Promise<{ panelName: string }> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "short-turn-panel",
      topic: "Brief exchange",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "Brief exchange prompt",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "Yes.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "No.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "Maybe.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "Okay.",
    });
    await new DebateRepository(db).update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

describe("buildExportCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-export-test-"));
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

  it("registers an 'export' command with required panel arg + format/output options", () => {
    const cmd = buildExportCommand();
    expect(cmd.name()).toBe("export");
    expect(cmd.description()).toMatch(/export|transcript|share|panel/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--format");
    expect(longs).toContain("--output");
  });

  it("rejects unknown panel name with clear error", async () => {
    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", "no-such-panel"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
  });

  it("explains when a panel template exists but no debates have been created", async () => {
    const panelsDir = path.join(testHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "empty-panel.yaml"),
      [
        "name: empty-panel",
        "description: Empty panel template",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );

    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", "empty-panel"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toMatch(/exists but has no debates yet/i);
    expect(thrown).toMatch(/convene --template empty-panel/i);
  });

  it("checks the separate data home before reporting a template-only panel as missing", async () => {
    const dataHomeBeforeOverride = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "library-home");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "data-home-template.yaml"),
      [
        "name: data-home-template",
        "description: Template stored in the separate data home",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );
    process.env["COUNCIL_DATA_HOME"] = libraryHome;

    try {
      const cmd = buildExportCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-export", "data-home-template"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toMatch(/exists but has no debates yet/i);
      expect(thrown).toMatch(/convene --template data-home-template/i);
    } finally {
      if (dataHomeBeforeOverride === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = dataHomeBeforeOverride;
    }
  });

  it("uses config.paths.dataHome when resolving template-only panel errors", async () => {
    const dataHomeBeforeOverride = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "config-data-home");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "config-export-template.yaml"),
      [
        "name: config-export-template",
        "description: Template stored in config.paths.dataHome",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );
    delete process.env["COUNCIL_DATA_HOME"];
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `paths:\n  dataHome: "${libraryHome.replace(/\\/g, "/")}"\n`,
      "utf-8",
    );

    try {
      const cmd = buildExportCommand({ write: () => undefined });
      cmd.exitOverride();
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-export", "config-export-template"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toMatch(/exists but has no debates yet/i);
      expect(thrown).toMatch(/convene --template config-export-template/i);
    } finally {
      if (dataHomeBeforeOverride === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = dataHomeBeforeOverride;
    }
  });

  it("does not emit the contradictory 'No panel found matching' diagnostic on the config-dataHome retry path", async () => {
    const dataHomeBeforeOverride = process.env["COUNCIL_DATA_HOME"];
    const libraryHome = path.join(testHome, "config-data-home-silent");
    const panelsDir = path.join(libraryHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "silent-probe-template.yaml"),
      [
        "name: silent-probe-template",
        "description: Template stored only in config.paths.dataHome",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );
    delete process.env["COUNCIL_DATA_HOME"];
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `paths:\n  dataHome: "${libraryHome.replace(/\\/g, "/")}"\n`,
      "utf-8",
    );

    try {
      let stderr = "";
      const cmd = buildExportCommand({
        write: () => undefined,
        writeError: (s) => {
          stderr += s;
        },
      });
      cmd.exitOverride();
      try {
        await cmd.parseAsync(["node", "council-export", "silent-probe-template"]);
      } catch {
        /* expected */
      }
      expect(stderr).toMatch(/exists but has no debates yet/i);
      expect(stderr).toMatch(/convene --template silent-probe-template/i);
      expect(stderr).not.toMatch(/No panel found matching/i);
    } finally {
      if (dataHomeBeforeOverride === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = dataHomeBeforeOverride;
    }
  });

  it("--format markdown (default): includes topic, status, expert displayNames, content", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName]);

    expect(captured).toContain("Should we ship the MVP?"); // topic / prompt
    expect(captured.toLowerCase()).toMatch(/status.*completed|completed/);
    // Expert attribution by displayName
    expect(captured).toContain("CTO");
    expect(captured).toContain("PM");
    // Turn content
    expect(captured).toContain("ship now to get user feedback fast");
    expect(captured).toContain("hold two weeks for the auth flow");
    expect(captured).toContain("launch behind a feature flag now");
    // Markdown structure — at least one heading
    expect(captured).toMatch(/^#/m);
  });

  it("--format json: emits NDJSON identical-shape to resume --format json", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "json"]);

    const lines = captured.split("\n").filter((l) => l.trim().startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { kind: string });
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds.filter((k) => k === "turn.end")).toHaveLength(3);
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("--format adr: emits ADR template with Status, Context, Options, Decision sections", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    // ADR canonical headers
    expect(captured).toMatch(/Decision Record|^# /m);
    expect(captured.toLowerCase()).toContain("status");
    expect(captured.toLowerCase()).toContain("context");
    expect(captured.toLowerCase()).toMatch(/options|positions|considered/);
    expect(captured.toLowerCase()).toContain("decision");
    // The user prompt (Context) must appear
    expect(captured).toContain("Should we ship the MVP?");
    // Final synthesis content should appear in Decision section
    expect(captured).toContain("launch behind a feature flag now");
  });

  it("--format adr: uses the first debate prompt for Context and includes content from all debates", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    // Context is always the FIRST debate's prompt (original question).
    expect(captured).toContain("Original first debate prompt");
    // All resumed debate turns must appear in the Discussion section.
    expect(captured).toContain("First debate opening note.");
    expect(captured).toContain("CTO analysis: shipping behind a feature flag balances risk.");
    expect(captured).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(captured).toContain("PM conclusion: agree to phased launch after checklist.");
    // The latest debate's turn must also be present now.
    expect(captured).toContain("Latest short debate note.");
  });

  it("--format adr: marks a completed debate with very short turns as Proposed", async () => {
    const seed = await seedPanelWithShortTurns(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toMatch(/## Status\s+\s*Proposed/m);
    expect(captured).not.toContain("Accepted");
  });

  it("--format markdown strips terminal controls from interpolated content while preserving markdown, unicode, and newlines", async () => {
    const seed = await seedPanelWithUnsafeDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);

    expectNoTerminalControls(captured);
    expect(captured).toContain("# export-sanitize");
    expect(captured).toContain("> Ship red now?");
    expect(captured).toContain("**CTO** (`cto`) - claude31m-sonnet-4");
    expect(captured).toContain("> Legit **markdown** café 🎉");
    expect(captured).toContain("> Second line ≥ baseline");
  });

  it("--format markdown sanitizes fallback speaker headings when no expert id is present", async () => {
    const seed = await seedPanelWithUnsafeFallbackSpeaker(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);

    expectNoTerminalControls(captured);
    expect(captured).toContain("#### moderator31m");
    expect(captured).toContain("> Fallback speaker content.");
  });

  it.each([
    ["CR", "alpha\rbeta"],
    ["CRLF", "alpha\r\nbeta"],
    ["Unicode line separator", "alpha\u2028beta"],
    ["Unicode paragraph separator", "alpha\u2029beta"],
  ])("--format markdown prefixes every block-quote line after %s", async (_name, content) => {
    const seed = await seedPanelWithUnsafeLineBreakContent(testHome, content);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);

    expect(captured).not.toContain(content);
    expect(captured).toContain("> alpha\n> beta");
  });

  it("--format adr strips terminal controls from headings and transcript content while preserving legitimate body text", async () => {
    const seed = await seedPanelWithUnsafeDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expectNoTerminalControls(captured);
    expect(captured).toContain("# Decision Record: Ship red now?");
    expect(captured).toContain("Prompt with controls");
    expect(captured).toContain("### CTO's position");
    expect(captured).toContain("> Legit **markdown** café 🎉");
    expect(captured).toContain("> Second line ≥ baseline");
  });

  it("--output <path> writes to file instead of stdout", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const outPath = path.join(testHome, "transcript.md");
    let stdoutCaptured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        stdoutCaptured += s;
      },
    });
    await cmd.parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "markdown",
      "--output",
      outPath,
    ]);

    // File should exist with the expected content.
    const fileContent = await fs.readFile(outPath, "utf-8");
    expect(fileContent).toContain("CTO");
    expect(fileContent).toContain("ship now to get user feedback fast");
    // stdout should NOT have the transcript content (only maybe a "Wrote..." confirmation).
    expect(stdoutCaptured).not.toContain("ship now to get user feedback fast");
  });

  it("--output <path> preserves UTF-8 punctuation and emoji in markdown exports", async () => {
    const seed = await seedPanelWithUnicodeDebate(testHome);
    const outPath = path.join(testHome, "transcript-unicode.md");
    const cmd = buildExportCommand({ write: () => undefined });
    await cmd.parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "markdown",
      "--output",
      outPath,
    ]);

    const fileBytes = await fs.readFile(outPath);
    expect(fileBytes.includes(Buffer.from(seed.unicodeSnippet, "utf8"))).toBe(true);
    expect(fileBytes.toString("utf8")).toContain(seed.unicodeSnippet);
    expect(fileBytes.toString("utf8")).toContain("CTO 🎯");
  });

  it("registers a --force option to allow overwriting --output", () => {
    const cmd = buildExportCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--force");
  });

  it("--output refuses to overwrite an existing file without --force", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const outPath = path.join(testHome, "existing.md");
    await fs.writeFile(outPath, "ORIGINAL", "utf-8");
    let errCaptured = "";
    const cmd = buildExportCommand({
      write: () => undefined,
      writeError: (s) => {
        errCaptured += s;
      },
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-export",
        seed.panelName,
        "--format",
        "markdown",
        "--output",
        outPath,
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(`${thrown} ${errCaptured}`.toLowerCase()).toMatch(/exists|overwrite|--force/);
    // The pre-existing file must be left untouched.
    expect(await fs.readFile(outPath, "utf-8")).toBe("ORIGINAL");
  });

  it("--output --force overwrites an existing file", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const outPath = path.join(testHome, "overwrite-me.md");
    await fs.writeFile(outPath, "ORIGINAL", "utf-8");
    const cmd = buildExportCommand({ write: () => undefined });
    await cmd.parseAsync([
      "node",
      "council-export",
      seed.panelName,
      "--format",
      "markdown",
      "--output",
      outPath,
      "--force",
    ]);
    const fileContent = await fs.readFile(outPath, "utf-8");
    expect(fileContent).not.toBe("ORIGINAL");
    expect(fileContent).toContain("CTO");
  });

  it("--output refuses a symlink target (no symlink follow)", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const secret = path.join(testHome, "secret.txt");
    await fs.writeFile(secret, "SECRET", "utf-8");
    const linkPath = path.join(testHome, "link.md");
    await fs.symlink(secret, linkPath);
    let errCaptured = "";
    const cmd = buildExportCommand({
      write: () => undefined,
      writeError: (s) => {
        errCaptured += s;
      },
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-export",
        seed.panelName,
        "--output",
        linkPath,
        "--force",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(`${thrown} ${errCaptured}`.toLowerCase()).toMatch(/regular file|symlink|not.*file/);
    // The symlink's target must not have been overwritten.
    expect(await fs.readFile(secret, "utf-8")).toBe("SECRET");
  });

  it("--output refuses a directory target", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const dirPath = path.join(testHome, "outdir");
    await fs.mkdir(dirPath, { recursive: true });
    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--output", dirPath]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/regular file|directory|not.*file/);
  });

  it("resolveOutputPath rejects a relative --output that escapes the working directory (#173)", async () => {
    const escapeTarget = path.join(
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      `council-nope-${process.pid}`,
      "passwd-probe",
    );
    await expect(resolveOutputPath(escapeTarget, false)).rejects.toThrow(
      /outside|working directory|refus/i,
    );
  });

  it("--output rejects a ../.. path-traversal escape without writing (regression #173)", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const escapeTarget = path.join(
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      `council-nope-${process.pid}`,
      "passwd-probe.md",
    );
    const cmd = buildExportCommand({ write: () => undefined, writeError: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--output", escapeTarget]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/outside|working directory|refus/);
    // The traversal target must never be created.
    const exists = await fs.access(path.resolve(escapeTarget)).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "resolveOutputPath surfaces a non-ENOENT lstat error instead of swallowing it (#1792)",
    async () => {
      const noAccessDir = path.join(testHome, "noaccess");
      await fs.mkdir(noAccessDir);
      await fs.chmod(noAccessDir, 0o000);
      try {
        await expect(resolveOutputPath(path.join(noAccessDir, "child.md"), false)).rejects.toThrow(
          /EACCES|permission/i,
        );
      } finally {
        await fs.chmod(noAccessDir, 0o755);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "writeExportArtifact refuses to follow a symlink target even with force (#1792)",
    async () => {
      const secret = path.join(testHome, "secret.txt");
      await fs.writeFile(secret, "SECRET", "utf-8");
      const link = path.join(testHome, "attacker-link.md");
      await fs.symlink(secret, link);
      await expect(writeExportArtifact(link, "CLOBBERED", true)).rejects.toThrow();
      // The symlink's target must not have been overwritten.
      expect(await fs.readFile(secret, "utf-8")).toBe("SECRET");
    },
  );

  it("writeExportArtifact refuses to clobber a file that appears after the pre-check without force (#1792)", async () => {
    const target = path.join(testHome, "raced.md");
    await fs.writeFile(target, "PREEXISTING", "utf-8");
    await expect(writeExportArtifact(target, "NEW-CONTENT", false)).rejects.toThrow(/exist/i);
    expect(await fs.readFile(target, "utf-8")).toBe("PREEXISTING");
  });

  it("--format adr per-line-prefixes multi-line Discussion turns so content cannot forge sections (#1475)", async () => {
    const maliciousContent = [
      "I vote to ship.",
      "## Pwned Section",
      "",
      "FORGED-PWNED-BODY here.",
    ].join("\n");
    const seed = await seedPanelWithAdrInjectionContent(testHome, maliciousContent);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    // The forged heading/body must never appear at column 0, where it would
    // forge a top-level ADR section; it survives only as indented list content.
    expect(captured).not.toMatch(/^## Pwned Section/m);
    expect(captured).not.toMatch(/^FORGED-PWNED-BODY/m);
    expect(captured).toContain("  ## Pwned Section");
    expect(captured).toContain("  FORGED-PWNED-BODY here.");
    // The first line stays on the list bullet.
    expect(captured).toContain("- **CTO**: I vote to ship.");
  });

  it("--format markdown sanitizes the resolved panel name in the 'Next:' hint (#1476)", async () => {
    const seed = await seedPanelWithUnsafeName(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);

    const nextLine = captured.split("\n").find((l) => l.startsWith("Next:")) ?? "";
    expect(nextLine).toContain("Next: council conclude ");
    expect(nextLine).toContain("council resume ");
    expectNoTerminalControls(nextLine);
    // Control/line-break chars collapsed away; legible name fragments remain.
    expect(nextLine).toContain("boardroom");
    expect(nextLine).toContain("Injected");
  });

  it("--format garbage rejects with clear error", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildExportCommand({ write: () => undefined });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "yaml"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/yaml|format.*expected|unknown.*format/);
  });

  it("--format adr: single-round debate shows 'no further discussion' message", async () => {
    // Seed a panel with exactly 1 turn per expert (single round, no synthesis round)
    const db = await createDatabase(path.join(testHome, "council.db"));
    let panelName: string;
    try {
      const panel = await new PanelRepository(db).create({
        name: "single-round",
        topic: "Quick decision",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const cto = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "You are a CTO.",
      });
      const pm = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "pm",
        displayName: "PM",
        model: "claude-sonnet-4",
        systemMessage: "You are a PM.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Quick decision needed",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "CTO says: ship it immediately.",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: pm.id,
        content: "PM says: agreed, let's go.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      panelName = panel.name;
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", panelName, "--format", "adr"]);

    // Should contain the single-round fallback message
    expect(captured.toLowerCase()).toContain("single round");
    expect(captured.toLowerCase()).toContain("no further discussion");
    expect(captured).toMatch(/## Status\s+\s*Proposed/m);
    // Decision section should still render with expert positions
    expect(captured.toLowerCase()).toContain("decision");
    expect(captured).toContain("CTO");
    expect(captured).toContain("PM");
  });

  it("matches a panel by unique name prefix (parity with `council resume`)", async () => {
    const seed = await seedPanelWithDebate(testHome); // name = "export-test"
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    // Use a short unambiguous prefix instead of the full name.
    await cmd.parseAsync(["node", "council-export", "export-te"]);

    expect(captured).toContain("CTO");
    expect(captured).toContain("ship now to get user feedback fast");
    // Header should use the full resolved panel name.
    expect(captured).toContain(`# ${seed.panelName}`);
  });

  it("rejects ambiguous prefix and lists matching panels", async () => {
    // Two panels both starting with "export-".
    await seedPanelWithDebate(testHome); // "export-test"
    await seedPanelWithMultipleDebates(testHome); // "export-multi-debate"

    let errCaptured = "";
    const cmd = buildExportCommand({
      write: () => undefined,
      writeError: (s) => {
        errCaptured += s;
      },
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-export", "export"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/ambiguous|multiple/);
    expect(errCaptured).toContain("export-test");
    expect(errCaptured).toContain("export-multi-debate");
  });

  it("exact name match still works when a longer name shares the same prefix (backward compatible)", async () => {
    // Seed two panels: "export-test" and "export-test-extended".
    await seedPanelWithDebate(testHome); // "export-test"
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "export-test-extended",
        topic: "Different topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const cto = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "cto",
        displayName: "CTO",
        model: "claude-sonnet-4",
        systemMessage: "You are a CTO.",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Different prompt",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "Extended panel content marker.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    // Exact name "export-test" must resolve to the export-test panel,
    // NOT trigger an ambiguous-prefix error against "export-test-extended".
    await cmd.parseAsync(["node", "council-export", "export-test"]);

    expect(captured).toContain("ship now to get user feedback fast");
    expect(captured).not.toContain("Extended panel content marker.");
  });

  it("--format markdown: includes turns from ALL debates of a resumed panel", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName]);

    // Every debate's content must appear.
    expect(captured).toContain("First debate opening note.");
    expect(captured).toContain("CTO analysis: shipping behind a feature flag balances risk.");
    expect(captured).toContain("PM analysis: auth checklist must be complete first.");
    expect(captured).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(captured).toContain("PM conclusion: agree to phased launch after checklist.");
    expect(captured).toContain("Latest short debate note.");
  });

  it("--format json: NDJSON includes turn.end events from ALL debates of a resumed panel", async () => {
    const seed = await seedPanelWithMultipleDebates(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "json"]);

    const events = captured
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as { kind: string; content?: string });
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    // 1 + 4 + 1 = 6 turns across the three debates.
    expect(turnEnds).toHaveLength(6);
    const contents = turnEnds.map((e) => e.content);
    expect(contents).toContain("First debate opening note.");
    expect(contents).toContain("CTO conclusion: ship behind a feature flag after checklist.");
    expect(contents).toContain("Latest short debate note.");
  });

  it("--format markdown: uses ASCII-safe separators without Unicode em-dash or mojibake", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName]);

    // Should NOT contain Unicode em-dash (U+2014)
    expect(captured).not.toContain("\u2014");
    // Should NOT contain common mojibake patterns for em-dash
    expect(captured).not.toContain("ΓÇö");
    expect(captured).not.toContain("\uFFFD"); // replacement character
    // Should use exact ASCII hyphen separator (issue #737)
    expect(captured).toContain("**CTO** (`cto`) - claude-sonnet-4");
    expect(captured).toContain("**PM** (`pm`) - claude-sonnet-4");
  });
});

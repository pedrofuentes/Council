/**
 * Tests for `council export <panel> --format md|json|adr [--output <path>]`
 * (ROADMAP §3.6).
 *
 * RED at this commit: src/cli/commands/export.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildExportCommand,
  resolveOutputPath,
  writeExportArtifact,
} from "../../../../src/cli/commands/export.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { EXIT_USER_ERROR } from "../../../../src/cli/exit-codes.js";
import { handleCliError } from "../../../../src/cli/handle-cli-error.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Wrap fs.rename, fs.open and fs.rm so individual tests can force the atomic
// rename-into-place, the temp-file write/close, or the temp-cleanup rm to fail
// deterministically; every other fs call (and all three by default) passes
// through to the real implementation. ESM namespaces cannot be spied, so the
// failure must be injected via vi.mock (see template-migration-fileexists.test).
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = (await importOriginal()) as typeof fs;
  return { ...real, rename: vi.fn(real.rename), open: vi.fn(real.open), rm: vi.fn(real.rm) };
});

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const BIDI_OVERRIDE = "\u202E";
const ZERO_WIDTH_SPACE = "\u200B";
const WIN32 = process.platform === "win32";

// Terminal-hostile bytes that must never reach stderr: C0 controls (0x00-0x1f),
// DEL + C1 (0x7f-0x9f), Unicode line/paragraph separators, bidi overrides
// (202a-202e) and bidi isolates (2066-2069). A discriminating check that the
// export error path is sanitized, beyond the specific bytes fed in.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

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

async function seedPanelWithIncompleteDebate(testHome: string): Promise<{ panelName: string }> {
  // A substantive but NON-completed debate (status "interrupted") so the ADR
  // exercises the `${status} (incomplete)` branch of deriveAdrStatus (#717).
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "incomplete-panel",
      topic: "Unfinished deliberation",
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
      prompt: "Unfinished deliberation prompt",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO opening: we need substantially more analysis before deciding anything here.",
    });
    await new DebateRepository(db).update(debate.id, { status: "interrupted" });
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

  it("--format adr escapes leading block markers on multi-line Discussion turns so content cannot forge sections (#1475/#1884)", async () => {
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

    // The forged heading must never render as an ATX heading at ANY legal
    // leading indent (CommonMark allows 0-3 spaces before the hashes), so it
    // can neither forge a top-level ADR section nor spoof the heading outline.
    expect(captured).not.toMatch(/^ {0,3}#{1,6}\s+Pwned Section/m);
    // The forged body must not break out to column 0 as its own top-level block.
    expect(captured).not.toMatch(/^FORGED-PWNED-BODY/m);
    // The leading hash is backslash-escaped, so it survives only as literal
    // text inside the list item — never as structure.
    expect(captured).toContain("  \\## Pwned Section");
    expect(captured).toContain("  FORGED-PWNED-BODY here.");
    // The first line stays on the list bullet.
    expect(captured).toContain("- **CTO**: I vote to ship.");
  });

  it("--format adr neutralizes the full block-injection class in Discussion continuations (#1884)", async () => {
    // A single multi-line turn that tries to open every kind of CommonMark
    // block from a continuation line: ATX heading, thematic break, fenced
    // code, and a raw-HTML block. None may render as structure.
    const payload = [
      "Position stated for the record.",
      "## Injected Heading",
      "----",
      "```js",
      "exfiltrate()",
      "```",
      "<h2>Injected HTML</h2>",
    ].join("\n");
    const seed = await seedPanelWithAdrInjectionContent(testHome, payload);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    // ATX heading: no valid heading survives at any legal 0-3 space indent.
    expect(captured).not.toMatch(/^ {0,3}#{1,6}\s+Injected Heading/m);
    expect(captured).toContain("  \\## Injected Heading");
    // Thematic break: the real ADR footer is exactly '---'; the injected
    // '----' (4 dashes) must never appear as an un-escaped break line.
    expect(captured).not.toMatch(/^ {0,3}-{4,}\s*$/m);
    expect(captured).toContain("  \\----");
    // Fenced code: no fence may open (which would swallow later sections).
    expect(captured).not.toMatch(/^ {0,3}`{3}/m);
    expect(captured).toContain("  \\```js");
    // Raw-HTML block: no HTML block may open at line start.
    expect(captured).not.toMatch(/^ {0,3}<h2>/m);
    expect(captured).toContain("  \\<h2>Injected HTML");
    // The benign first line still rides the list bullet.
    expect(captured).toContain("- **CTO**: Position stated for the record.");
  });

  // #1884 (outline spoofing) — the Discussion "Full transcript" list renders each
  // turn as a bullet whose extra lines are continuations. Backslash-escaping a
  // leading marker is NOT sufficient on its own: once a blank line closes the
  // bullet's paragraph, a continuation indented 4+ columns (four spaces, or a
  // single tab — CommonMark expands tabs to 4-column stops) opens an INDENTED
  // CODE block, and that code block even swallows the escaped marker as literal
  // text. The renderer must therefore also STRIP leading indentation so no
  // continuation line can open any block. Each `forbidden` pattern below is the
  // exact structural form CommonMark parses as a block start (cross-checked with
  // a CommonMark renderer), so its ABSENCE from the emitted Markdown proves the
  // payload stays literal; `present` pins the neutralized/benign text that must
  // survive. Patterns are anchored to a 0-3 space line start so they never match
  // the Options/Decision blockquote (`> ...`) lines of the same turn.
  interface AdrBlockInjectionCase {
    readonly label: string;
    readonly content: string;
    readonly forbidden: readonly RegExp[];
    readonly present: readonly string[];
  }

  const ADR_BLOCK_INJECTION_CASES: readonly AdrBlockInjectionCase[] = [
    {
      label: "ATX headings at every legal 0-3 space indent",
      content: ["Weighing the tradeoffs.", "# ONE", " ## TWO", "  ### THREE", "   ###### SIX"].join(
        "\n",
      ),
      forbidden: [/^ {0,3}#{1,6}\s+(?:ONE|TWO|THREE|SIX)\b/m],
      present: ["Weighing the tradeoffs.", "\\# ONE", "\\## TWO", "\\### THREE", "\\###### SIX"],
    },
    {
      label: "thematic breaks (---- / *** / ___)",
      content: ["Weighing the tradeoffs.", "----", "***", "___"].join("\n"),
      forbidden: [/^ {0,3}-{4,}\s*$/m, /^ {0,3}\*{3,}\s*$/m, /^ {0,3}_{3,}\s*$/m],
      present: ["\\----", "\\***", "\\___"],
    },
    {
      label: "fenced code (``` and ~~~)",
      content: ["Weighing the tradeoffs.", "```js", "exfiltrate()", "```", "~~~", "x", "~~~"].join(
        "\n",
      ),
      forbidden: [/^ {0,3}`{3,}/m, /^ {0,3}~{3,}/m],
      present: ["\\```js", "\\~~~"],
    },
    {
      label: "indented code via blank line + four spaces",
      content: ["Weighing the tradeoffs.", "", "    exfiltrate('SP4')"].join("\n"),
      forbidden: [/^ {4,}exfiltrate/m],
      present: ["Weighing the tradeoffs.", "exfiltrate('SP4')"],
    },
    {
      label: "indented code via blank line + a leading tab",
      content: ["Weighing the tradeoffs.", "", "\texfiltrate('TAB')"].join("\n"),
      forbidden: [/^ {0,3}\texfiltrate/m],
      present: ["exfiltrate('TAB')"],
    },
    {
      label: "indented code carrying heading text (blank line + four spaces + ##)",
      content: ["Weighing the tradeoffs.", "", "    ## STILL-CODE"].join("\n"),
      forbidden: [/^ {4,}\S.*STILL-CODE/m, /^ {0,3}#{1,6}\s+STILL-CODE/m],
      present: ["STILL-CODE"],
    },
    {
      label: "raw-HTML block starters (<h2>, <script>, <!--)",
      content: [
        "Weighing the tradeoffs.",
        "<h2>HTML Injected</h2>",
        "<script>evil()</script>",
        "<!-- pwn -->",
      ].join("\n"),
      forbidden: [/^ {0,3}<h2>/m, /^ {0,3}<script>/m, /^ {0,3}<!--/m],
      present: ["\\<h2>HTML Injected", "\\<script>evil", "\\<!-- pwn"],
    },
  ];

  it.each(ADR_BLOCK_INJECTION_CASES)(
    "--format adr keeps a Discussion continuation from opening a block: $label (#1884)",
    async ({ content, forbidden, present }) => {
      const seed = await seedPanelWithAdrInjectionContent(testHome, content);
      let captured = "";
      const cmd = buildExportCommand({
        write: (s) => {
          captured += s;
        },
      });
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

      for (const pattern of forbidden) {
        expect(captured).not.toMatch(pattern);
      }
      for (const literal of present) {
        expect(captured).toContain(literal);
      }
    },
  );

  it("--format adr leaves a benign multi-line Discussion turn unescaped and unindented (#1884)", async () => {
    // Inverse/golden: normal prose (no leading whitespace, no block markers) must
    // render exactly as before — continuations pinned at the 2-space list column
    // as plain paragraph text, with no spurious backslash-escape or code indent.
    const benign = [
      "We should ship now.",
      "",
      "It lowers risk and gathers real feedback.",
      "Ops can monitor the rollout.",
    ].join("\n");
    const seed = await seedPanelWithAdrInjectionContent(testHome, benign);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toContain("- **CTO**: We should ship now.");
    expect(captured).toMatch(/^ {2}It lowers risk and gathers real feedback\.$/m);
    expect(captured).toMatch(/^ {2}Ops can monitor the rollout\.$/m);
    // No safe prose line was over-escaped or pushed to a code-forming indent.
    expect(captured).not.toContain("\\It lowers");
    expect(captured).not.toContain("\\Ops can");
    expect(captured).not.toMatch(/^ {4,}(?:It lowers|Ops can)/m);
  });

  // #2110 (outline spoofing, security) — the per-expert BLOCKQUOTE emitters render
  // each untrusted paragraph as `> ${para}` in three places: the Markdown Transcript
  // (`renderMarkdown`) and the ADR Options + Decision blockquotes (`renderAdr`).
  // CommonMark honours block markers INSIDE a blockquote (`> ## X` → nested heading,
  // `> ---`/`> ===` → <hr>/setext heading, `> ``` ` → code fence, `> <x>` → raw-HTML
  // block, `>     x` → indented code), so a model-derived paragraph that begins with a
  // block marker forges structure in the exported outline — the same class #1884 fixed
  // for ADR Discussion continuation lines. The fix routes every blockquoted paragraph
  // through the SAME `escapeBlockLeadingMarkdown` neutralization (strip leading indent +
  // backslash-escape the leading marker). Each `forbidden` pattern is the exact
  // structural form CommonMark parses as a block start on a `> ` line (the emitter always
  // prefixes a single `> `, so a legal 0-3 space block indent lands 1-4 columns past the
  // `>`); its ABSENCE proves the payload stays literal, while `present` pins the
  // neutralized `> \marker` text that must survive.
  const BLOCKQUOTE_BENIGN_ANCHOR = "Position stated for the record.";

  interface BlockquoteInjectionCase {
    readonly label: string;
    readonly content: string;
    readonly forbidden: readonly RegExp[];
    readonly present: readonly string[];
  }

  const BLOCKQUOTE_INJECTION_CASES: readonly BlockquoteInjectionCase[] = [
    {
      label: "ATX headings at every legal 0-3 space indent (# .. ######)",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "# ONE", " ## TWO", "  ### THREE", "   ###### SIX"].join(
        "\n",
      ),
      forbidden: [/^>[ ]{1,4}#{1,6}(?:\s|$)/m],
      present: ["> \\# ONE", "> \\## TWO", "> \\### THREE", "> \\###### SIX"],
    },
    {
      label: "setext heading underline (===) forging an H1 from the anchor line",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "==="].join("\n"),
      forbidden: [/^>[ ]{1,4}={2,}\s*$/m],
      present: ["> \\==="],
    },
    {
      label: "thematic breaks (---- / *** / ___)",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "----", "***", "___"].join("\n"),
      forbidden: [/^>[ ]{1,4}-{3,}\s*$/m, /^>[ ]{1,4}\*{3,}\s*$/m, /^>[ ]{1,4}_{3,}\s*$/m],
      present: ["> \\----", "> \\***", "> \\___"],
    },
    {
      label: "fenced code (``` and ~~~)",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "```js", "exfiltrate()", "```", "~~~", "x", "~~~"].join(
        "\n",
      ),
      forbidden: [/^>[ ]{1,4}`{3,}/m, /^>[ ]{1,4}~{3,}/m],
      present: ["> \\```js", "> \\~~~"],
    },
    {
      label: "indented code via blank line + four spaces",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "", "    exfiltrate('SP4')"].join("\n"),
      forbidden: [/^>[ ]{4,}exfiltrate/m],
      present: ["> exfiltrate('SP4')"],
    },
    {
      label: "indented code via blank line + a leading tab",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "", "\texfiltrate('TAB')"].join("\n"),
      forbidden: [/^>[ ]\texfiltrate/m],
      present: ["> exfiltrate('TAB')"],
    },
    {
      label: "indented code carrying heading text (four spaces + ##)",
      content: [BLOCKQUOTE_BENIGN_ANCHOR, "", "    ## STILL-CODE"].join("\n"),
      forbidden: [/^>[ ]{4,}\S.*STILL-CODE/m, /^>[ ]{1,4}#{1,6}\s+STILL-CODE/m],
      present: ["> \\## STILL-CODE"],
    },
    {
      label: "raw-HTML block starters (<h2>, <script>, <!--)",
      content: [
        BLOCKQUOTE_BENIGN_ANCHOR,
        "<h2>HTML Injected</h2>",
        "<script>evil()</script>",
        "<!-- pwn -->",
      ].join("\n"),
      forbidden: [/^>[ ]{1,4}<h2>/m, /^>[ ]{1,4}<script>/m, /^>[ ]{1,4}<!--/m],
      present: ["> \\<h2>HTML Injected", "> \\<script>evil", "> \\<!-- pwn"],
    },
  ];

  it.each(BLOCKQUOTE_INJECTION_CASES)(
    "--format markdown keeps a per-expert transcript blockquote from opening a block: $label (#2110)",
    async ({ content, forbidden, present }) => {
      const seed = await seedPanelWithUnsafeLineBreakContent(testHome, content);
      let captured = "";
      const cmd = buildExportCommand({
        write: (s) => {
          captured += s;
        },
      });
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);

      for (const pattern of forbidden) {
        expect(captured).not.toMatch(pattern);
      }
      for (const literal of present) {
        expect(captured).toContain(literal);
      }
      // The benign anchor still rides its own blockquote line as literal prose.
      expect(captured).toContain(`> ${BLOCKQUOTE_BENIGN_ANCHOR}`);
    },
  );

  it.each(BLOCKQUOTE_INJECTION_CASES)(
    "--format adr keeps the Options AND Decision per-expert blockquotes from opening a block: $label (#2110)",
    async ({ content, forbidden, present }) => {
      // One turn → position === synthesis === payload, so the SAME untrusted paragraph
      // flows through BOTH the Options blockquote (`> ${position}`) and the Decision
      // blockquote (`> ${synthesis}`) with no Discussion "Full transcript" continuation
      // (single round) to muddy the oracle. Pinning the neutralized literal inside EACH
      // section proves both emitters are hardened independently.
      const seed = await seedPanelWithUnsafeLineBreakContent(testHome, content);
      let captured = "";
      const cmd = buildExportCommand({
        write: (s) => {
          captured += s;
        },
      });
      await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

      for (const pattern of forbidden) {
        expect(captured).not.toMatch(pattern);
      }
      const optionsSection = captured.slice(
        captured.indexOf("## Options Considered"),
        captured.indexOf("## Discussion"),
      );
      const decisionSection = captured.slice(captured.indexOf("## Decision"));
      expect(optionsSection).not.toBe("");
      expect(decisionSection).not.toBe("");
      for (const literal of present) {
        expect(optionsSection).toContain(literal);
        expect(decisionSection).toContain(literal);
      }
    },
  );

  it("--format markdown leaves benign per-expert transcript paragraphs unescaped (#2110)", async () => {
    // Inverse/golden: normal prose (no leading whitespace, no block markers) must render
    // exactly as before — each paragraph line pinned inside its blockquote as plain text
    // with no spurious backslash-escape.
    const benign = [
      "We should ship now.",
      "",
      "It lowers risk and gathers real feedback.",
      "Ops can monitor the rollout.",
    ].join("\n");
    const seed = await seedPanelWithUnsafeLineBreakContent(testHome, benign);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "markdown"]);

    expect(captured).toContain("> We should ship now.");
    expect(captured).toContain("> It lowers risk and gathers real feedback.");
    expect(captured).toContain("> Ops can monitor the rollout.");
    // No benign blockquote line was spuriously escaped.
    expect(captured).not.toContain("> \\");
  });

  it("--format adr leaves benign Options and Decision blockquotes unescaped (#2110)", async () => {
    // Inverse/golden for both ADR blockquote emitters.
    const benign = ["We should ship now.", "", "It lowers risk and gathers real feedback."].join(
      "\n",
    );
    const seed = await seedPanelWithUnsafeLineBreakContent(testHome, benign);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    const optionsSection = captured.slice(
      captured.indexOf("## Options Considered"),
      captured.indexOf("## Discussion"),
    );
    const decisionSection = captured.slice(captured.indexOf("## Decision"));
    expect(optionsSection).toContain("> We should ship now.");
    expect(optionsSection).toContain("> It lowers risk and gathers real feedback.");
    expect(decisionSection).toContain("> We should ship now.");
    expect(decisionSection).toContain("> It lowers risk and gathers real feedback.");
    expect(optionsSection).not.toContain("> \\");
    expect(decisionSection).not.toContain("> \\");
  });

  it.skipIf(WIN32)(
    "resolveOutputPath rejects a relative --output whose parent symlink escapes the tree (#1885)",
    async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-export-outside-"));
      const originalCwd = process.cwd();
      try {
        process.chdir(testHome);
        // Pre-plant an in-CWD symlink pointing OUT of the tree. Lexically
        // `evil/out.md` stays under CWD, but its real parent is `outsideDir`.
        await fs.symlink(outsideDir, path.join(testHome, "evil"));
        await expect(resolveOutputPath(path.join("evil", "out.md"), false)).rejects.toThrow(
          /outside|working directory|refus/i,
        );
        // Inverse: a genuinely in-tree relative path still resolves cleanly.
        await expect(resolveOutputPath("in-tree.md", false)).resolves.toContain("in-tree.md");
      } finally {
        process.chdir(originalCwd);
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(WIN32)(
    "resolveOutputPath rejects a relative --output with an intermediate-dir symlink escape (#1885)",
    async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-export-outside-"));
      const originalCwd = process.cwd();
      try {
        process.chdir(testHome);
        await fs.mkdir(path.join(testHome, "nested"));
        await fs.symlink(outsideDir, path.join(testHome, "nested", "link"));
        await expect(
          resolveOutputPath(path.join("nested", "link", "out.md"), false),
        ).rejects.toThrow(/outside|working directory|refus/i);
      } finally {
        process.chdir(originalCwd);
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("resolveOutputPath returns a target whose parent is realpath-resolved (#1883)", async () => {
    // Runs on every platform (no symlink needed): the parent dereference is
    // the guard that protects platforms where O_NOFOLLOW is unavailable
    // (Windows), by ensuring the final open/rename only faces the last
    // path component.
    const dir = path.join(testHome, "plain-parent");
    await fs.mkdir(dir);
    const resolved = await resolveOutputPath(path.join(dir, "out.md"), false);
    expect(path.dirname(resolved)).toBe(await fs.realpath(dir));
    expect(path.basename(resolved)).toBe("out.md");
  });

  it.skipIf(WIN32)(
    "resolveOutputPath dereferences a symlinked parent so no symlinked ancestor remains (#1883)",
    async () => {
      const realDir = path.join(testHome, "real-dir");
      await fs.mkdir(realDir);
      const linkDir = path.join(testHome, "link-dir");
      await fs.symlink(realDir, linkDir);
      // An absolute --output through an IN-TREE symlinked parent is allowed,
      // but the returned target must be dereferenced to the real directory.
      const resolved = await resolveOutputPath(path.join(linkDir, "out.md"), false);
      expect(path.dirname(resolved)).toBe(await fs.realpath(realDir));
      expect(path.basename(resolved)).toBe("out.md");
    },
  );

  it.skipIf(WIN32)(
    "writeExportArtifact --force replaces via atomic rename, never truncating a hard-linked sibling (#1886)",
    async () => {
      const victim = path.join(testHome, "victim.txt");
      await fs.writeFile(victim, "IMPORTANT-DO-NOT-TRUNCATE", "utf-8");
      const target = path.join(testHome, "target.md");
      // A hard link models a regular file swapped in at the target between the
      // pre-check and the write: it shares the victim's inode.
      await fs.link(victim, target);
      const before = await fs.stat(target);

      await writeExportArtifact(target, "NEW EXPORT CONTENT", true);

      // The target now holds the export...
      expect(await fs.readFile(target, "utf-8")).toBe("NEW EXPORT CONTENT");
      // ...but the hard-linked sibling is untouched. An in-place O_TRUNC would
      // have truncated the shared inode; rename-into-place swaps the name.
      expect(await fs.readFile(victim, "utf-8")).toBe("IMPORTANT-DO-NOT-TRUNCATE");
      // Inode changed → proves rename-into-place rather than truncate-in-place.
      expect((await fs.stat(target)).ino).not.toBe(before.ino);
      // The temp sibling is renamed away, not left behind.
      const leftovers = (await fs.readdir(testHome)).filter((e) => e.includes(".tmp"));
      expect(leftovers).toEqual([]);
    },
  );

  it("resolveOutputPath wraps a non-ENOENT lstat error as a sanitized CliUserError (exit 1) (#1887)", async () => {
    // An intermediate path component that is a regular file makes lstat on a
    // child fail with ENOTDIR — a non-ENOENT error whose raw Node message would
    // otherwise embed the un-sanitized --output path (with ANSI/control bytes).
    const notDir = path.join(testHome, "not-a-dir");
    await fs.writeFile(notDir, "x", "utf-8");
    const ansiLeaf = `${ESC}[31m${C1_CSI}child${BIDI_OVERRIDE}${ZERO_WIDTH_SPACE}.md`;
    const outPath = path.join(notDir, ansiLeaf);

    let caught: unknown;
    try {
      await resolveOutputPath(outPath, true);
    } catch (err) {
      caught = err;
    }
    // (a) User error → exit 1, not the raw-Node internal-error code 4.
    expect(caught).toBeInstanceOf(CliUserError);

    // Production stderr path: for a CliUserError, handleCliError writes NOTHING
    // (the pre-sanitized message is not re-emitted) and returns the user-error
    // exit code, so stderr is EXACTLY empty. Asserting silence is the DISCRIMINATING
    // #1966 oracle: the old `expectNoTerminalControls(stderr)` was vacuous because
    // stderr is always "" here. Were the wrap removed, `caught` would be the raw fs
    // error (with a `code`), handleCliError would emit `Error: <raw message>\n`, and
    // this `toBe("")` would fail on the leaked path/ANSI bytes.
    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");

    // (b) The error's own message is single-line and free of control bytes.
    const message = caught instanceof Error ? caught.message : String(caught);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);
    expect(message.split("\n")).toHaveLength(1);
  });

  it("writeExportArtifact --force wraps a non-ENOENT lstat error (ENOTDIR) as a sanitized CliUserError (exit 1) (#1887)", async () => {
    // A regular file used as a parent directory makes the --force pre-write
    // lstat on a child fail with ENOTDIR — a non-ENOENT error the write path
    // used to raw-rethrow, exiting 4 (INTERNAL) and leaking the un-sanitized
    // target path (ANSI/control bytes) through handleCliError's `Error: <msg>`.
    const notDir = path.join(testHome, "force-not-a-dir");
    await fs.writeFile(notDir, "x", "utf-8");
    const ansiLeaf = `${ESC}[31m${C1_CSI}child${BIDI_OVERRIDE}${ZERO_WIDTH_SPACE}.md`;
    const target = path.join(notDir, ansiLeaf);

    let caught: unknown;
    try {
      await writeExportArtifact(target, "CONTENT", true);
    } catch (err) {
      caught = err;
    }
    // (a) User error → exit 1, not the raw-Node internal-error code 4.
    expect(caught).toBeInstanceOf(CliUserError);

    // handleCliError stays SILENT for a CliUserError, so stderr is exactly empty
    // (the pre-sanitized message is not re-emitted). DISCRIMINATING #1966 oracle:
    // were the wrap removed, the raw ENOTDIR error (with a `code`) would be emitted
    // here and `toBe("")` would fail on the leaked control bytes.
    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");

    // (b) The error's own message is single-line and free of control bytes.
    const message = caught instanceof Error ? caught.message : String(caught);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);
    expect(message.split("\n")).toHaveLength(1);
  });

  it("writeExportArtifact --force wraps a rename failure as a sanitized CliUserError (exit 1) (#1887)", async () => {
    // Force the atomic rename-into-place to fail with a non-ENOENT fs error
    // whose raw Node message embeds terminal-control bytes. The write path used
    // to raw-rethrow it, exiting 4 (INTERNAL) and printing the message verbatim.
    const target = path.join(testHome, "rename-fail.md");
    const renameErr = Object.assign(
      new Error(`EACCES: permission denied, rename '${ESC}[31m${C1_CSI}${BIDI_OVERRIDE}victim'`),
      { code: "EACCES" },
    );
    vi.mocked(fs.rename).mockRejectedValueOnce(renameErr);

    let caught: unknown;
    try {
      await writeExportArtifact(target, "CONTENT", true);
    } catch (err) {
      caught = err;
    }
    // (a) User error → exit 1, not the raw-Node internal-error code 4.
    expect(caught).toBeInstanceOf(CliUserError);

    // handleCliError stays SILENT for a CliUserError, so stderr is exactly empty
    // (the pre-sanitized message is not re-emitted). DISCRIMINATING #1966 oracle:
    // were the wrap removed, the raw rename error (with a `code`) would be emitted
    // here and `toBe("")` would fail on the leaked control bytes.
    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");

    // (b) The wrapped message never interpolates the raw fs error message, so the
    // control bytes it carried are absent; it stays single-line and sanitized.
    const message = caught instanceof Error ? caught.message : String(caught);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);
    expect(message.split("\n")).toHaveLength(1);
  });

  // #1965: the writeExportArtifact fs-wrap error branches — the non-force O_EXCL
  // create, and the --force temp open/writeFile/close — funnel every raw Node fs
  // error through the outer catch, which WRAPS it in a sanitized `CliUserError`
  // (exit 1, errno LABEL only, never the raw `err.message`). Only the --force
  // lstat-ENOTDIR and rename-failure paths had dedicated wrap coverage; these add
  // a discriminating test per remaining branch (each FAILS if the wrap is removed,
  // because a raw rethrow is not a `CliUserError` and — with a `code` — is echoed
  // verbatim by handleCliError, leaking the path/ANSI it embeds).
  it("writeExportArtifact (no --force) wraps an O_EXCL EEXIST as a sanitized CliUserError (exit 1) without clobbering the target (#1965)", async () => {
    // A file already occupying the path makes the atomic `O_CREAT | O_EXCL` create
    // fail with EEXIST. That raw Node error must be WRAPPED, not rethrown: a rethrow
    // exits 4 (INTERNAL) and echoes the raw "file already exists" message + path.
    const target = path.join(testHome, "occupied.md");
    await fs.writeFile(target, "PREEXISTING", "utf-8");

    let caught: unknown;
    try {
      await writeExportArtifact(target, "NEW CONTENT", false);
    } catch (err) {
      caught = err;
    }

    // (a) Wrapped as a user error (exit 1), not the raw-Node internal-error code 4,
    // and the EEXIST branch really fired (the raw error is the wrap's `cause`).
    expect(caught).toBeInstanceOf(CliUserError);
    const cause = (caught as CliUserError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as NodeJS.ErrnoException).code).toBe("EEXIST");

    // (b) The message surfaces the errno LABEL (actionable) but NOT the raw Node
    // "already exists" phrasing — proof it is the sanitized wrap, not a raw rethrow.
    const message = (caught as CliUserError).message;
    expect(message).toMatch(/Cannot write export/);
    expect(message).toContain("EEXIST");
    expect(message).not.toMatch(/already exists/i);
    expect(message.split("\n")).toHaveLength(1);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);

    // (c) handleCliError is SILENT for a CliUserError (#1966 silence contract):
    // were the wrap gone, the raw EEXIST error (code set) would be emitted here.
    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");

    // (d) O_EXCL never opened the existing file, so its contents are untouched.
    expect(await fs.readFile(target, "utf-8")).toBe("PREEXISTING");
  });

  it("writeExportArtifact --force wraps a temp-file open failure (EACCES) as a sanitized CliUserError, never leaking the raw fs message (#1965)", async () => {
    // The --force flow opens a private O_EXCL temp sibling before the atomic
    // rename. If that open rejects, the outer catch must wrap it into a sanitized
    // CliUserError whose message carries only the errno LABEL — never the raw fs
    // `err.message`, which embeds a path with terminal-control bytes.
    const target = path.join(testHome, "temp-open-fail.md");
    const openErr = Object.assign(
      new Error(`EACCES: permission denied, open '${ESC}[31m${C1_CSI}${BIDI_OVERRIDE}temp'`),
      { code: "EACCES" },
    );
    vi.mocked(fs.open).mockRejectedValueOnce(openErr);

    let caught: unknown;
    try {
      await writeExportArtifact(target, "CONTENT", true);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliUserError);
    expect((caught as CliUserError).cause).toBe(openErr);
    const message = (caught as CliUserError).message;
    expect(message).toMatch(/Cannot write export/);
    expect(message).toContain("EACCES");
    // Raw Node phrasing is absent → the wrap uses the errno label, not err.message.
    expect(message).not.toContain("permission denied");
    expect(message.split("\n")).toHaveLength(1);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);

    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");

    // The failed open never created a temp sibling.
    const leftovers = (await fs.readdir(testHome)).filter((e) => e.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("writeExportArtifact --force wraps a temp writeFile failure (EIO) as a sanitized CliUserError, never leaking the raw fs message (#1965)", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const target = path.join(testHome, "temp-write-fail.md");
    const writeErr = Object.assign(
      new Error(`EIO: i/o error, write '${ESC}[31m${C1_CSI}${BIDI_OVERRIDE}temp'`),
      { code: "EIO" },
    );
    // The real O_EXCL temp lands, then its write rejects with an adversarial message.
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      return {
        writeFile: async (): Promise<void> => {
          throw writeErr;
        },
        close: (): Promise<void> => handle.close(),
      } as unknown as fs.FileHandle;
    });

    let caught: unknown;
    try {
      await writeExportArtifact(target, "CONTENT", true);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliUserError);
    expect((caught as CliUserError).cause).toBe(writeErr);
    const message = (caught as CliUserError).message;
    expect(message).toMatch(/Cannot write export/);
    expect(message).toContain("EIO");
    expect(message).not.toContain("i/o error");
    expect(message.split("\n")).toHaveLength(1);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);

    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");
  });

  it("writeExportArtifact --force wraps a temp close failure (EIO) as a sanitized CliUserError, never leaking the raw fs message (#1965)", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const target = path.join(testHome, "temp-close-fail.md");
    const closeErr = Object.assign(
      new Error(`EIO: i/o error, close '${ESC}[31m${C1_CSI}${BIDI_OVERRIDE}temp'`),
      { code: "EIO" },
    );
    // writeFile lands the bytes for real; close rejects after flushing.
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      return {
        writeFile: (data: string | Uint8Array): Promise<void> => handle.writeFile(data),
        close: async (): Promise<void> => {
          await handle.close();
          throw closeErr;
        },
      } as unknown as fs.FileHandle;
    });

    let caught: unknown;
    try {
      await writeExportArtifact(target, "CONTENT", true);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliUserError);
    expect((caught as CliUserError).cause).toBe(closeErr);
    const message = (caught as CliUserError).message;
    expect(message).toMatch(/Cannot write export/);
    expect(message).toContain("EIO");
    expect(message).not.toContain("i/o error");
    expect(message.split("\n")).toHaveLength(1);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);

    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");
  });

  // #1966: the CliUserError-path stderr oracle in the #1887 tests was VACUOUS —
  // handleCliError writes NOTHING for a CliUserError, so `stderr` is always "" and
  // `expectNoTerminalControls(stderr)` passed regardless of impl. This oracle is
  // DISCRIMINATING: it feeds the FULL terminal-hostile class (TAB, C0, C1, DEL,
  // bidi override + isolate, CR-LF, U+2028/U+2029) through the target PATH and
  // asserts the wrapped message is a SINGLE sanitized line — verifying Council uses
  // `toSingleLineDisplay` (collapses the separators) and NOT `stripControlChars`
  // (which would leave CR/LF/U+2028/U+2029 and yield a multi-line message).
  it("writeExportArtifact surfaces a single-line, control-free CliUserError for a fully terminal-hostile target path, staying silent on the handleCliError path (#1966)", async () => {
    // Raw control bytes assembled via String.fromCharCode (this file's convention),
    // plus the Unicode separators. Legible fragments ("adv"/"report"/"name") survive.
    const c0 = [0x00, 0x07, 0x0b, 0x0c, 0x1f, 0x7f]
      .map((code) => String.fromCharCode(code))
      .join("");
    const adversarialTarget = path.join(
      testHome,
      `adv${c0}${C1_CSI}${ESC}[31m${BIDI_OVERRIDE}\u2066report\t\r\n\u2028\u2029name.md`,
    );
    // The injected fs error ALSO carries adversarial bytes + a `code`, so a raw
    // rethrow would be emitted verbatim by handleCliError — which is exactly what
    // the stderr silence assertion below discriminates against.
    const openErr = Object.assign(
      new Error(`EACCES: denied ${ESC}[31m${BIDI_OVERRIDE}\r\nInjected`),
      { code: "EACCES" },
    );
    vi.mocked(fs.open).mockRejectedValueOnce(openErr);

    let caught: unknown;
    try {
      await writeExportArtifact(adversarialTarget, "CONTENT", false);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliUserError);
    const message = (caught as CliUserError).message;

    // Single control-free line — FAILS if the sanitizer were downgraded to
    // stripControlChars (CR/LF/U+2028/U+2029 would survive as line breaks) or if
    // the path were interpolated raw (the control bytes would leak).
    expect(message.split("\n")).toHaveLength(1);
    expectNoTerminalControls(message);
    expect(message).not.toMatch(TERMINAL_CONTROL_BYTES);
    // The sanitizer collapses/strips the hostile bytes but keeps legible text.
    expect(message).toContain("report");
    expect(message).toContain("name");
    expect(message).toContain("EACCES");

    // Silence contract: handleCliError emits NOTHING for a CliUserError. Were the
    // wrap removed, the raw EACCES error (adversarial message + code) would be
    // echoed here and BOTH assertions below would fail on the leaked control bytes.
    let stderr = "";
    const exit = handleCliError(caught, (s) => {
      stderr += s;
    });
    expect(exit).toBe(EXIT_USER_ERROR);
    expect(stderr).toBe("");
    expect(stderr).not.toMatch(TERMINAL_CONTROL_BYTES);
  });

  // #1964: the --force write-to-temp-then-rename flow only removed the temp
  // sibling inside the rename catch. Any failure BETWEEN creating the O_EXCL
  // temp and a successful rename — a rejected writeFile or close — therefore
  // leaked a partially-written export artifact on disk. Cleanup must now cover
  // every failure mode while leaving a successful export untouched.
  it("writeExportArtifact --force removes the temp sibling when writeFile fails before the rename (#1964)", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const target = path.join(testHome, "write-fail.md");
    const writeErr = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });

    // The O_EXCL temp sibling is created for real (it must land on disk), then
    // its write rejects — modelling a mid-write failure (e.g. a full disk)
    // after the temp already exists. Pre-fix nothing removed it.
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      return {
        writeFile: async (): Promise<void> => {
          throw writeErr;
        },
        close: (): Promise<void> => handle.close(),
      } as unknown as fs.FileHandle;
    });

    // The failure still surfaces as a sanitized user error...
    await expect(writeExportArtifact(target, "CONTENT", true)).rejects.toBeInstanceOf(CliUserError);

    // ...no temp sibling survives the failed write...
    const leftovers = (await fs.readdir(testHome)).filter((e) => e.includes(".tmp"));
    expect(leftovers).toEqual([]);
    // ...and the final artifact was never created.
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("writeExportArtifact --force removes the temp sibling when close fails before the rename (#1964)", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const target = path.join(testHome, "close-fail.md");
    const closeErr = Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });

    // writeFile lands the bytes for real, but close rejects after flushing — the
    // temp now holds a complete artifact yet the rename (and its catch) is never
    // reached, so pre-fix the artifact leaked.
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      return {
        writeFile: (data: string | Uint8Array): Promise<void> => handle.writeFile(data),
        close: async (): Promise<void> => {
          await handle.close();
          throw closeErr;
        },
      } as unknown as fs.FileHandle;
    });

    await expect(writeExportArtifact(target, "CONTENT", true)).rejects.toBeInstanceOf(CliUserError);

    const leftovers = (await fs.readdir(testHome)).filter((e) => e.includes(".tmp"));
    expect(leftovers).toEqual([]);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("writeExportArtifact --force removes the temp sibling when the rename fails (#1964)", async () => {
    // Inverse invariant / regression guard: the pre-existing rename-catch
    // cleanup must survive the refactor that broadened it to writeFile/close.
    const target = path.join(testHome, "rename-fail-cleanup.md");
    const renameErr = Object.assign(new Error("EXDEV: cross-device link, rename"), {
      code: "EXDEV",
    });
    vi.mocked(fs.rename).mockRejectedValueOnce(renameErr);

    await expect(writeExportArtifact(target, "CONTENT", true)).rejects.toBeInstanceOf(CliUserError);

    const leftovers = (await fs.readdir(testHome)).filter((e) => e.includes(".tmp"));
    expect(leftovers).toEqual([]);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("writeExportArtifact --force leaves no temp sibling on a successful export (#1964)", async () => {
    // Inverse invariant: the broadened cleanup must NOT fire on success — the
    // temp is renamed away, the final artifact stays, and nothing lingers.
    const target = path.join(testHome, "force-success.md");

    await writeExportArtifact(target, "FINAL CONTENT", true);

    expect(await fs.readFile(target, "utf-8")).toBe("FINAL CONTENT");
    const leftovers = (await fs.readdir(testHome)).filter((e) => e.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  // #2100 (sentinel:important, security): the broadened temp-cleanup path
  // swallowed a non-ENOENT `fs.rm` rejection with `.catch(() => undefined)`. On a
  // compound fault (the write/rename fails AND the cleanup rm ITSELF fails with
  // EACCES/EBUSY/EPERM/EIO) the 0o600 temp sibling — which may hold exported
  // transcript content — survived on disk with NO diagnostic. The cleanup must
  // now SURFACE a sanitized, single-line warning that names the leaked temp path
  // and the cleanup errno, WITHOUT masking the primary write/rename error.
  it("writeExportArtifact --force surfaces a diagnostic (and leaves the temp) when cleanup fs.rm fails with a non-ENOENT error, without masking the primary error (#2100)", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const target = path.join(testHome, "double-fault.md");
    // Primary fault: the temp write rejects. The O_EXCL sibling is created for
    // real, so a genuine 0o600 file is on disk to leak.
    const writeErr = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
    // Second fault: the cleanup rm ITSELF rejects with a non-ENOENT error
    // (e.g. a Windows AV/indexer lock on the temp sibling).
    const rmErr = Object.assign(new Error("EACCES: permission denied, rm"), { code: "EACCES" });

    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      return {
        writeFile: async (): Promise<void> => {
          throw writeErr;
        },
        close: (): Promise<void> => handle.close(),
      } as unknown as fs.FileHandle;
    });
    vi.mocked(fs.rm).mockRejectedValueOnce(rmErr);

    const warnings: string[] = [];
    const writeError = (s: string): void => {
      warnings.push(s);
    };

    let caught: unknown;
    try {
      await writeExportArtifact(target, "SENSITIVE CONTENT", true, writeError);
    } catch (err) {
      caught = err;
    }

    // The PRIMARY (write) error propagates — the cleanup failure must not mask it.
    expect(caught).toBeInstanceOf(CliUserError);
    const caughtErr = caught as CliUserError;
    expect(caughtErr.cause).toBe(writeErr);
    expect(caughtErr.message).toContain("ENOSPC");
    expect(caughtErr.message).not.toContain("EACCES");

    // A discriminating diagnostic names BOTH the leaked temp path and the cleanup
    // errno so the stray sensitive file is observable.
    const warned = warnings.join("");
    expect(warned).toMatch(/temporary export file/i);
    expect(warned).toContain("double-fault.md");
    expect(warned).toContain(".tmp");
    expect(warned).toContain("EACCES");

    // The leak is real: the mocked rm did not remove the 0o600 temp sibling.
    const leftovers = (await actual.readdir(testHome)).filter((e) => e.includes(".tmp"));
    expect(leftovers.length).toBeGreaterThan(0);
    // Tidy up so afterEach's recursive rm has less to do.
    await Promise.all(leftovers.map((e) => actual.rm(path.join(testHome, e), { force: true })));
  });

  it("writeExportArtifact --force stays silent when cleanup fs.rm rejects with ENOENT (already gone), still propagating the primary error (#2100)", async () => {
    const target = path.join(testHome, "enoent-cleanup.md");
    const writeErr = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, rm"), {
      code: "ENOENT",
    });

    // Fake handle: no real temp lands (models "already gone"); the write rejects.
    vi.mocked(fs.open).mockImplementationOnce(
      async (): Promise<fs.FileHandle> =>
        ({
          writeFile: async (): Promise<void> => {
            throw writeErr;
          },
          close: async (): Promise<void> => undefined,
        }) as unknown as fs.FileHandle,
    );
    vi.mocked(fs.rm).mockRejectedValueOnce(enoent);

    const warnings: string[] = [];
    const writeError = (s: string): void => {
      warnings.push(s);
    };

    let caught: unknown;
    try {
      await writeExportArtifact(target, "CONTENT", true, writeError);
    } catch (err) {
      caught = err;
    }

    // Primary error still propagates...
    expect(caught).toBeInstanceOf(CliUserError);
    expect((caught as CliUserError).cause).toBe(writeErr);
    // ...but an ENOENT cleanup rejection is benign, so NO diagnostic is emitted.
    expect(warnings.join("")).toBe("");
  });

  it.skipIf(WIN32)(
    "writeExportArtifact --force strips terminal-control bytes out of the temp-cleanup diagnostic (#2100)",
    async () => {
      // The temp path derives from the (untrusted) --output basename. A crafted
      // name embeds ESC/C1/bidi/zero-width bytes; the surfaced diagnostic must be
      // a single control-free line so it cannot spoof the terminal. (Skipped on
      // Windows, whose filenames cannot carry these bytes.)
      const target = path.join(
        testHome,
        `adv${ESC}[31m${C1_CSI}${BIDI_OVERRIDE}report${ZERO_WIDTH_SPACE}.md`,
      );
      const writeErr = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      const rmErr = Object.assign(new Error("EBUSY: resource busy or locked, rm"), {
        code: "EBUSY",
      });

      vi.mocked(fs.open).mockImplementationOnce(
        async (): Promise<fs.FileHandle> =>
          ({
            writeFile: async (): Promise<void> => {
              throw writeErr;
            },
            close: async (): Promise<void> => undefined,
          }) as unknown as fs.FileHandle,
      );
      vi.mocked(fs.rm).mockRejectedValueOnce(rmErr);

      const warnings: string[] = [];
      const writeError = (s: string): void => {
        warnings.push(s);
      };

      await expect(writeExportArtifact(target, "CONTENT", true, writeError)).rejects.toBeInstanceOf(
        CliUserError,
      );

      // Trailing newline aside, the surfaced diagnostic is a single sanitized line
      // that still names the errno (actionable) but carries no terminal-hostile byte.
      const warnLine = warnings.join("").replace(/\n+$/, "");
      expect(warnLine).toContain("EBUSY");
      expectNoTerminalControls(warnLine);
      expect(warnLine).not.toMatch(TERMINAL_CONTROL_BYTES);
      expect(warnLine.split("\n")).toHaveLength(1);
    },
  );

  it("writeExportArtifact --force emits no cleanup diagnostic on a successful export (#2100)", async () => {
    // Inverse invariant: the success path never enters cleanup, so the diagnostic
    // channel stays silent and the artifact is written normally.
    const target = path.join(testHome, "success-no-warn.md");
    const warnings: string[] = [];
    const writeError = (s: string): void => {
      warnings.push(s);
    };

    await writeExportArtifact(target, "FINAL CONTENT", true, writeError);

    expect(await fs.readFile(target, "utf-8")).toBe("FINAL CONTENT");
    expect(warnings.join("")).toBe("");
  });

  it("--format adr: marks a substantive completed debate as Accepted (#717)", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toMatch(/## Status\s+\s*Accepted/m);
    expect(captured).not.toMatch(/## Status\s+\s*Proposed/m);
    expect(captured).not.toContain("(incomplete)");
  });

  it("--format adr: renders a non-completed debate status as incomplete (#717)", async () => {
    const seed = await seedPanelWithIncompleteDebate(testHome);
    let captured = "";
    const cmd = buildExportCommand({
      write: (s) => {
        captured += s;
      },
    });
    await cmd.parseAsync(["node", "council-export", seed.panelName, "--format", "adr"]);

    expect(captured).toMatch(/## Status\s+\s*interrupted \(incomplete\)/m);
    expect(captured).not.toContain("Accepted");
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

/**
 * Tests for `council conclude [panel] --engine <kind> [--format json|plain]`.
 *
 * Conclude reads the latest debate transcript for a panel, sends a
 * structured synthesis prompt through the engine using a temporary
 * "synthesizer" expert, parses the JSON response into a
 * `ConcludeOutput`, and renders it in plain or JSON format.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConcludeCommand,
  buildSynthesisPrompt,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_TURNS,
  type ConcludeOutput,
} from "../../../../src/cli/commands/conclude.js";
import type { TranscriptDocument } from "../../../../src/memory/transcript.js";
import type { Turn } from "../../../../src/memory/repositories/turns.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { buildProgram } from "../../../../src/bin/council.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { ExpertSpec } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import { DebateRepository } from "../../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../../src/memory/repositories/turns.js";

const SYNTH_ID = "synthesizer-fixed-id-for-tests";

const SAMPLE_OUTPUT: Omit<ConcludeOutput, "panelName" | "topic"> = {
  consensus: [
    "Both experts agree the monolith has real coupling pain points",
    "Team size is a material constraint",
  ],
  tensions: [
    "CTO wants migration now, PM wants to wait for hiring",
    "Operational overhead concerns are unresolved",
  ],
  decisionMatrix: [
    {
      dimension: "Risk",
      positions: [
        { expert: "CTO", stance: "High operational risk" },
        { expert: "PM", stance: "Medium velocity risk" },
      ],
    },
    {
      dimension: "Timeline",
      positions: [
        { expert: "CTO", stance: "18 months" },
        { expert: "PM", stance: "6 months" },
      ],
    },
  ],
  recommendation:
    "Begin a phased migration starting with the auth subsystem, behind a feature flag.",
  confidence: "medium",
};

interface SeedResult {
  readonly panelName: string;
}

async function seedPanelWithDebate(testHome: string, name = "conclude-test"): Promise<SeedResult> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name,
      topic: "Should we migrate to microservices?",
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
      prompt: "Should we migrate to microservices?",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO: the monolith's coupling is a real problem; we should split.",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId: pm.id,
      content: "PM: I agree on the pain, but timing matters; we lack ops headcount.",
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

async function seedEmptyDebatePanel(
  testHome: string,
  name = "conclude-empty",
): Promise<SeedResult> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name,
      topic: "Empty topic",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const debate = await new DebateRepository(db).create({
      panelId: panel.id,
      prompt: "No turns happened",
      moderator: "round-robin",
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

async function seedPanelWithRunningDebate(
  testHome: string,
  name = "conclude-running",
): Promise<SeedResult> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name,
      topic: "Running debate topic",
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
      prompt: "Running debate topic",
      moderator: "round-robin",
    });
    await new TurnRepository(db).create({
      debateId: debate.id,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId: cto.id,
      content: "CTO: a thought captured before the debate finished.",
    });
    // Intentionally do NOT mark the debate completed — leaves status "running".
    return { panelName: panel.name };
  } finally {
    await db.destroy();
  }
}

function makeMockEngine(jsonResponse: string): MockEngine {
  return new MockEngine({
    responses: { [SYNTH_ID]: jsonResponse },
  });
}

describe("buildConcludeCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-conclude-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("registers a 'conclude' command with required engine option", () => {
    const cmd = buildConcludeCommand();
    expect(cmd.name()).toBe("conclude");
    expect(cmd.description()).toMatch(/synth|conclude|decision|debate|panel/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--engine");
    expect(longs).toContain("--format");
  });

  it("rejects unknown panel name with a clear error", async () => {
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-conclude", "no-such-panel", "--engine", "mock"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no panel|not found/);
  });

  it("matches a panel by unique name prefix", async () => {
    const seed = await seedPanelWithDebate(testHome, "conclude-prefix-panel");
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });

    await cmd.parseAsync(["node", "council-conclude", "conclude-prefix", "--engine", "mock"]);

    expect(captured).toContain(seed.panelName);
    expect(captured).toContain(SAMPLE_OUTPUT.recommendation);
  });

  it("resolves engine from config when --engine is omitted", async () => {
    const seed = await seedPanelWithDebate(testHome);
    // Write config with engine = mock so the command resolves it from config
    const configPath = path.join(testHome, "config.yaml");
    await fs.writeFile(configPath, "defaults:\n  engine: mock\n");

    let errorOutput = "";
    let stdOutput = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        stdOutput += s;
      },
      writeError: (s) => {
        errorOutput += s;
      },
      writeNotice: (s) => {
        errorOutput += s;
      },
      // NO engineFactory — exercises makeEngineFromKind(resolvedEngine)
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();

    // No --engine flag — should resolve "mock" from config and hit makeEngineFromKind
    // MockEngine now returns valid JSON for synthesizer, so the command should succeed
    await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--format", "json"]);

    // The MOCK ENGINE banner proves resolveEngine returned "mock" from config
    expect(errorOutput).toMatch(/MOCK ENGINE/);
    // The output should be valid JSON
    expect(() => JSON.parse(stdOutput)).not.toThrow();
    const output = JSON.parse(stdOutput);
    expect(output).toHaveProperty("consensus");
    expect(output).toHaveProperty("recommendation");
  });

  it("rejects unknown --engine value", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "openai"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/engine|expected|unknown/);
  });

  it("emits a clear error when the latest debate has no turns", async () => {
    const seed = await seedEmptyDebatePanel(testHome);
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/no turns|empty|nothing to/);
  });

  it("--format json: emits a JSON ConcludeOutput including panelName and topic", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync([
      "node",
      "council-conclude",
      seed.panelName,
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const parsed = JSON.parse(captured.trim()) as ConcludeOutput;
    expect(parsed.panelName).toBe(seed.panelName);
    expect(parsed.topic).toBe("Should we migrate to microservices?");
    expect(parsed.consensus).toEqual(SAMPLE_OUTPUT.consensus);
    expect(parsed.tensions).toEqual(SAMPLE_OUTPUT.tensions);
    expect(parsed.recommendation).toBe(SAMPLE_OUTPUT.recommendation);
    expect(parsed.confidence).toBe("medium");
    expect(parsed.decisionMatrix).toHaveLength(2);
    expect(parsed.decisionMatrix[0]?.dimension).toBe("Risk");
  });

  it("--format plain (default): renders consensus, tensions, recommendation, confidence", async () => {
    const seed = await seedPanelWithDebate(testHome);
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);

    expect(captured.toLowerCase()).toContain("consensus");
    expect(captured.toLowerCase()).toContain("tension");
    expect(captured.toLowerCase()).toContain("recommendation");
    expect(captured.toLowerCase()).toContain("confidence");
    // Topic appears in header
    expect(captured).toContain("Should we migrate to microservices?");
    // Sample content appears in output
    expect(captured).toContain("monolith");
    expect(captured).toContain("phased migration");
    expect(captured.toLowerCase()).toContain("medium");
  });

  it("synthesis prompt includes the topic and every expert turn", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const engine = makeMockEngine(JSON.stringify(SAMPLE_OUTPUT));
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);

    expect(engine.sentPrompts).toHaveLength(1);
    const prompt = engine.sentPrompts[0]?.prompt ?? "";
    expect(engine.sentPrompts[0]?.expertId).toBe(SYNTH_ID);
    // Topic is referenced in the prompt
    expect(prompt).toContain("Should we migrate to microservices?");
    // Each expert's displayName and turn content is included
    expect(prompt).toContain("CTO");
    expect(prompt).toContain("PM");
    expect(prompt).toContain("monolith's coupling is a real problem");
    expect(prompt).toContain("we lack ops headcount");
  });

  it("tolerates JSON wrapped in fenced ```json code blocks", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const fenced = "Here is the synthesis:\n```json\n" + JSON.stringify(SAMPLE_OUTPUT) + "\n```\n";
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(fenced),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync([
      "node",
      "council-conclude",
      seed.panelName,
      "--engine",
      "mock",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(captured.trim()) as ConcludeOutput;
    expect(parsed.recommendation).toBe(SAMPLE_OUTPUT.recommendation);
  });

  it("emits a clear error when the engine response is not valid JSON", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine("this is not JSON at all"),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/json|parse|invalid/);
  });

  it("defaults to the most recent panel when no name is given", async () => {
    await seedPanelWithDebate(testHome, "panel-old");
    // Panel ids are ULIDs (ms precision). Wait long enough to guarantee the
    // second panel's millisecond timestamp is strictly greater than the
    // first, so lexicographic ULID ordering is deterministic.
    await new Promise((r) => setTimeout(r, 30));
    const newer = await seedPanelWithDebate(testHome, "panel-newer");

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", "--engine", "mock", "--format", "json"]);

    const parsed = JSON.parse(captured.trim()) as ConcludeOutput;
    expect(parsed.panelName).toBe(newer.panelName);
  });

  it("rejects unknown --format value", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync([
        "node",
        "council-conclude",
        seed.panelName,
        "--engine",
        "mock",
        "--format",
        "yaml",
      ]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/format|expected|unknown/);
  });

  it("emits a warning when the latest debate is not completed", async () => {
    const seed = await seedPanelWithRunningDebate(testHome);
    let captured = "";
    let stderr = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: (s) => {
        stderr += s;
      },
      writeNotice: (s) => {
        stderr += s;
      },
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync([
      "node",
      "council-conclude",
      seed.panelName,
      "--engine",
      "mock",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(captured.trim()) as ConcludeOutput;
    expect(parsed.warnings).toBeDefined();
    expect((parsed.warnings ?? []).join(" ")).toMatch(/running|partial|not 'completed'/i);
    // Stderr should still mention the mock-engine banner (unrelated, sanity check).
    expect(stderr).toContain("MOCK ENGINE");
  });

  it("plain format surfaces the partial-debate warning in stdout", async () => {
    const seed = await seedPanelWithRunningDebate(testHome);
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    expect(captured.toLowerCase()).toContain("warning");
  });

  it("delimits the transcript in <transcript> tags to mitigate prompt injection", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const engine = makeMockEngine(JSON.stringify(SAMPLE_OUTPUT));
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    const prompt = engine.sentPrompts[0]?.prompt ?? "";
    expect(prompt).toContain("<transcript>");
    expect(prompt).toContain("</transcript>");
    // The expert turn content is inside the tags.
    const startIdx = prompt.indexOf("<transcript>");
    const endIdx = prompt.indexOf("</transcript>");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = prompt.slice(startIdx, endIdx);
    expect(body).toContain("monolith's coupling");
  });

  it("tolerates JSON wrapped in unfenced prose", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const proseWrapped =
      "Sure! Here is the synthesis you asked for:\n\n" +
      JSON.stringify(SAMPLE_OUTPUT) +
      "\n\nLet me know if you need anything else.";
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(proseWrapped),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync([
      "node",
      "council-conclude",
      seed.panelName,
      "--engine",
      "mock",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(captured.trim()) as ConcludeOutput;
    expect(parsed.recommendation).toBe(SAMPLE_OUTPUT.recommendation);
  });

  it("rejects engine response whose JSON fails Zod schema validation", async () => {
    const seed = await seedPanelWithDebate(testHome);
    // Valid JSON but schema-invalid: confidence is not in the enum.
    const badShape = JSON.stringify({
      consensus: [],
      tensions: [],
      decisionMatrix: [],
      recommendation: "ok",
      confidence: "uncertain",
    });
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(badShape),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/schema|invalid|confidence|expected/);
  });

  it("rejects malformed (non-JSON) engine response with a clear error", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => makeMockEngine("this is not json at all"),
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrown = "";
    try {
      await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown.toLowerCase()).toMatch(/failed to parse|json/);
    // Must NOT leak raw model output
    expect(thrown).not.toContain("this is not json at all");
  });

  it("emits one diagnostic when the engine fails during synthesis", async () => {
    const seed = await seedPanelWithDebate(testHome);
    const errorEngine = new MockEngine({
      failures: {
        [SYNTH_ID]: { code: "INTERNAL", message: "engine blew up" },
      },
    });
    let errOutput = "";
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: (s) => (errOutput += s),
      engineFactory: () => errorEngine,
      synthesizerId: SYNTH_ID,
    });
    cmd.exitOverride();
    let thrownErr: Error | undefined;
    try {
      await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    } catch (err) {
      thrownErr = err instanceof Error ? err : undefined;
    }
    // writeError should have been called with the engine diagnostic
    expect(errOutput).toMatch(/engine blew up|internal/i);
    // The thrown error should be a CliUserError (message already written)
    expect(thrownErr).toBeInstanceOf(CliUserError);
  });

  it("uses config.defaults.model for the synthesizer expert", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.writeFile(configPath, "defaults:\n  model: conclude-test-model\n");

    const seed = await seedPanelWithDebate(testHome);
    const addedSpecs: ExpertSpec[] = [];
    const spyEngine = makeMockEngine(JSON.stringify(SAMPLE_OUTPUT));
    const origAddExpert = spyEngine.addExpert.bind(spyEngine);
    spyEngine.addExpert = async (spec: ExpertSpec) => {
      addedSpecs.push(spec);
      return origAddExpert(spec);
    };

    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => spyEngine,
      synthesizerId: SYNTH_ID,
    });

    await cmd.parseAsync(["node", "council-conclude", seed.panelName, "--engine", "mock"]);
    expect(addedSpecs).toHaveLength(1);
    expect(addedSpecs[0]?.model).toBe("conclude-test-model");
  });

  it("buildProgram() registers the conclude command", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("conclude");
  });
});

function makeTranscriptDoc(turns: readonly Turn[]): TranscriptDocument {
  return {
    panel: {
      id: "p1",
      name: "test-panel",
      topic: "Test topic",
      copilotHome: "/tmp/copilot",
      configJson: "{}",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    },
    experts: [
      {
        id: "e1",
        panelId: "p1",
        slug: "cto",
        displayName: "CTO",
        model: "m",
        systemMessage: "",
        copilotSessionId: null,
        createdAt: "2025-01-01T00:00:00Z",
        extractedMemoryJson: null,
        memorySourceDebateId: null,
        memoryDerivation: null,
        memoryTrustScore: null,
        memoryExtractedAt: null,
      },
    ],
    originalPrompt: "Test topic",
    latestDebate: {
      id: "d1",
      prompt: "Test topic",
      status: "completed",
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: "2025-01-01T01:00:00Z",
    },
    turns,
  };
}

function makeTurn(seq: number, content: string): Turn {
  return {
    id: `t${seq}`,
    debateId: "d1",
    round: 0,
    seq,
    speakerKind: "expert",
    expertId: "e1",
    content,
    tokensIn: null,
    tokensOut: null,
    latencyMs: null,
    createdAt: "2025-01-01T00:00:00Z",
  };
}

describe("buildSynthesisPrompt — truncation reporting", () => {
  it("reports no truncation when turns and chars are under limits", () => {
    const turns = Array.from({ length: 5 }, (_, i) => makeTurn(i, "short content"));
    const result = buildSynthesisPrompt(makeTranscriptDoc(turns));
    expect(result.truncated).toBe(false);
    expect(result.truncatedByTurns).toBe(false);
    expect(result.truncatedByChars).toBe(false);
    expect(result.originalTurnCount).toBe(5);
    expect(result.finalTurnCount).toBe(5);
  });

  it("flags truncatedByTurns only when many short turns exceed turn limit", () => {
    const total = MAX_TRANSCRIPT_TURNS + 10;
    const turns = Array.from({ length: total }, (_, i) => makeTurn(i, "x"));
    const result = buildSynthesisPrompt(makeTranscriptDoc(turns));
    expect(result.truncated).toBe(true);
    expect(result.truncatedByTurns).toBe(true);
    expect(result.truncatedByChars).toBe(false);
    expect(result.originalTurnCount).toBe(total);
    expect(result.finalTurnCount).toBe(MAX_TRANSCRIPT_TURNS);
  });

  it("flags truncatedByChars only when few large turns exceed char budget", () => {
    // 16 turns of ~6000 chars each ≈ 96000 chars > 50000, but 16 < 50 turns
    const big = "a".repeat(6000);
    const turns = Array.from({ length: 16 }, (_, i) => makeTurn(i, big));
    const result = buildSynthesisPrompt(makeTranscriptDoc(turns));
    expect(result.truncated).toBe(true);
    expect(result.truncatedByTurns).toBe(false);
    expect(result.truncatedByChars).toBe(true);
    expect(result.originalTurnCount).toBe(16);
    expect(result.finalTurnCount).toBeLessThan(16);
    expect(result.finalTurnCount).toBeGreaterThan(0);
  });

  it("flags both truncatedByTurns and truncatedByChars when both limits exceeded", () => {
    const big = "b".repeat(2000);
    const turns = Array.from({ length: MAX_TRANSCRIPT_TURNS + 20 }, (_, i) => makeTurn(i, big));
    const result = buildSynthesisPrompt(makeTranscriptDoc(turns));
    expect(result.truncated).toBe(true);
    expect(result.truncatedByTurns).toBe(true);
    expect(result.truncatedByChars).toBe(true);
    expect(result.originalTurnCount).toBe(MAX_TRANSCRIPT_TURNS + 20);
    expect(result.finalTurnCount).toBeLessThan(MAX_TRANSCRIPT_TURNS);
  });

  it("does NOT mention 'last 50 turns' in warning for 16-turn, char-bound debate", async () => {
    const big = "c".repeat(6000);
    const turns = Array.from({ length: 16 }, (_, i) => makeTurn(i, big));
    const result = buildSynthesisPrompt(makeTranscriptDoc(turns));
    // Sanity check that this is the char-only scenario; warning rendering itself is
    // exercised by the integration-level conclude tests below.
    expect(result.truncatedByChars).toBe(true);
    expect(result.truncatedByTurns).toBe(false);
    expect(MAX_TRANSCRIPT_CHARS).toBe(50_000);
  });
});

describe("conclude — truncation warning rendering", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-conclude-trunc-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  async function seedPanelWithLargeTurns(
    name: string,
    turnCount: number,
    perTurnChars: number,
  ): Promise<string> {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name,
        topic: "Big debate",
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
        prompt: "Big debate",
        moderator: "round-robin",
      });
      const turnRepo = new TurnRepository(db);
      const blob = "x".repeat(perTurnChars);
      for (let i = 0; i < turnCount; i++) {
        await turnRepo.create({
          debateId: debate.id,
          round: 0,
          seq: i,
          speakerKind: "expert",
          expertId: cto.id,
          content: blob,
        });
      }
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      return panel.name;
    } finally {
      await db.destroy();
    }
  }

  it("does NOT show 'last 50 turns' warning for 16-turn / 80KB debate", async () => {
    const panelName = await seedPanelWithLargeTurns("conclude-16-turn-big", 16, 5500);
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);
    expect(captured).not.toMatch(/last 50 turns/);
    // Should still warn — but about the char budget, mentioning the real 16
    expect(captured).toMatch(/warning: transcript truncated/);
    expect(captured).toMatch(/16/);
    expect(captured).toMatch(/50000/);
  });

  it("shows turn-count truncation warning for 60-turn / small-content debate", async () => {
    const panelName = await seedPanelWithLargeTurns("conclude-60-turn-small", 60, 50);
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);
    expect(captured).toMatch(/warning: transcript truncated/);
    expect(captured).toMatch(/60/);
    expect(captured).toMatch(/50/);
    // Char limit not breached — message should not blame the char budget
    expect(captured).not.toMatch(/50000 char/);
  });

  it("emits NO truncation warning for small in-budget debate", async () => {
    const panelName = await seedPanelWithLargeTurns("conclude-small", 5, 100);
    let captured = "";
    const cmd = buildConcludeCommand({
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
      engineFactory: () => makeMockEngine(JSON.stringify(SAMPLE_OUTPUT)),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", panelName, "--engine", "mock"]);
    expect(captured).not.toMatch(/transcript truncated/);
  });
});

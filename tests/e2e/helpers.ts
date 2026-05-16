import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Writer } from "../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import { MockEngine, type MockEngineOptions } from "../../src/engine/mock/mock-engine.js";
import { type CouncilDatabase, createDatabase } from "../../src/memory/db.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";

const DEFAULT_PANEL_NAME = "test-panel";
const DEFAULT_TOPIC = "Test Topic";
const DEFAULT_PROMPT = "Should we use microservices?";
const DEFAULT_EXPERT_SLUGS = ["cto", "pm"];
const PANEL_CONFIG_JSON = JSON.stringify({ template: "code-review", mode: "freeform" });

export interface E2EContext {
  readonly testHome: string;
  readonly testDataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

function restoreEnvVar(
  name: "COUNCIL_HOME" | "COUNCIL_DATA_HOME",
  value: string | undefined,
): void {
  if (name === "COUNCIL_HOME") {
    if (value === undefined) delete process.env.COUNCIL_HOME;
    else process.env.COUNCIL_HOME = value;
    return;
  }

  if (value === undefined) delete process.env.COUNCIL_DATA_HOME;
  else process.env.COUNCIL_DATA_HOME = value;
}

async function removeDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export async function createE2EContext(): Promise<E2EContext> {
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-"));
  const testDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-data-"));

  try {
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testDataHome;
    await fs.mkdir(path.join(testDataHome, "experts"), { recursive: true });
    await fs.mkdir(path.join(testDataHome, "panels"), { recursive: true });

    return {
      testHome,
      testDataHome,
      originalHome,
      originalDataHome,
    };
  } catch (error: unknown) {
    restoreEnvVar("COUNCIL_HOME", originalHome);
    restoreEnvVar("COUNCIL_DATA_HOME", originalDataHome);
    await Promise.allSettled([removeDir(testHome), removeDir(testDataHome)]);
    throw error;
  }
}

export async function cleanupE2EContext(ctx: E2EContext): Promise<void> {
  restoreEnvVar("COUNCIL_HOME", ctx.originalHome);
  restoreEnvVar("COUNCIL_DATA_HOME", ctx.originalDataHome);
  await Promise.all([removeDir(ctx.testHome), removeDir(ctx.testDataHome)]);
}

export function captureOutput(): {
  write: Writer;
  writeError: Writer;
  stdout: () => string;
  stderr: () => string;
} {
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const write: Writer = (s) => {
    stdoutBuffer += s;
  };
  const writeError: Writer = (s) => {
    stderrBuffer += s;
  };

  return {
    write,
    writeError,
    stdout: (): string => stdoutBuffer,
    stderr: (): string => stderrBuffer,
  };
}

export function makeMockEngineFactory(
  options: MockEngineOptions = { responses: {} },
): () => CouncilEngine {
  const resolvedOptions: MockEngineOptions = { responses: {}, ...options };
  return () => new MockEngine(resolvedOptions);
}

export async function openTestDb(testHome: string): Promise<CouncilDatabase> {
  return createDatabase(path.join(testHome, "council.db"));
}

export async function seedPanelWithExperts(
  testHome: string,
  opts?: {
    readonly panelName?: string;
    readonly topic?: string;
    readonly expertSlugs?: readonly string[];
  },
): Promise<{ panelName: string; panelId: string; expertIds: string[] }> {
  const panelName = opts?.panelName ?? DEFAULT_PANEL_NAME;
  const topic = opts?.topic ?? DEFAULT_TOPIC;
  const expertSlugs = [...(opts?.expertSlugs ?? DEFAULT_EXPERT_SLUGS)];
  const db = await openTestDb(testHome);

  try {
    const panel = await new PanelRepository(db).create({
      name: panelName,
      topic,
      copilotHome: path.join(testHome, "panels", panelName, "copilot"),
      configJson: PANEL_CONFIG_JSON,
    });

    const expertRepo = new ExpertRepository(db);
    const expertIds: string[] = [];
    for (const slug of expertSlugs) {
      const expert = await expertRepo.create({
        panelId: panel.id,
        slug,
        displayName: slug.toUpperCase(),
        model: "claude-sonnet-4",
        systemMessage: `[1] IDENTITY\nYou are ${slug}.`,
      });
      expertIds.push(expert.id);
    }

    return { panelName, panelId: panel.id, expertIds };
  } finally {
    await db.destroy();
  }
}

export async function seedCompletedDebate(
  testHome: string,
  opts?: {
    readonly panelName?: string;
    readonly topic?: string;
    readonly prompt?: string;
  },
): Promise<{ panelName: string; panelId: string; debateId: string }> {
  const panelName = opts?.panelName ?? DEFAULT_PANEL_NAME;
  const topic = opts?.topic ?? DEFAULT_TOPIC;
  const prompt = opts?.prompt ?? DEFAULT_PROMPT;
  const seededPanel = await seedPanelWithExperts(testHome, { panelName, topic });
  const db = await openTestDb(testHome);

  try {
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);
    const debate = await debateRepo.create({
      panelId: seededPanel.panelId,
      prompt,
      moderator: "moderator",
    });

    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: seededPanel.expertIds[0] ?? null,
      content: "CTO perspective: prefer a modular monolith first.",
    });
    await turnRepo.create({
      debateId: debate.id,
      round: 1,
      seq: 2,
      speakerKind: "expert",
      expertId: seededPanel.expertIds[1] ?? null,
      content: "PM perspective: optimize for speed and learning.",
    });
    await debateRepo.update(debate.id, {
      status: "completed",
      endedAt: new Date().toISOString(),
    });

    return {
      panelName: seededPanel.panelName,
      panelId: seededPanel.panelId,
      debateId: debate.id,
    };
  } finally {
    await db.destroy();
  }
}

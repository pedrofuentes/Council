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
import { mkCanonicalTempDir } from "../helpers/tmp.js";

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

function normalizeTempPath(dirPath: string): string {
  const resolvedPath = path.resolve(dirPath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

/**
 * Determines if an error should be ignored during best-effort E2E cleanup.
 *
 * **Why each error code is allowed:**
 * - `EBUSY`: Windows file system indicates the file/directory is in use
 * - `EPERM`: Windows permissions error during deletion (often transient)
 * - `ENOTEMPTY`: Directory not empty (Windows async I/O latency)
 * - `sqlite_busy` / `database is locked`: SQLite/libsql handle release latency
 *
 * **Platform conditions:**
 * These errors primarily affect Windows CI due to async file handle release
 * behavior. SQLite database files may remain locked briefly after `db.destroy()`
 * returns, especially under heavy parallel test execution.
 *
 * **Adding new error codes:**
 * Before adding a new pattern to this allowlist, confirm the error is actually
 * related to Windows handle-release timing, not a genuine bug in test teardown.
 * Use word-boundary matching (`\b`) to avoid false positives.
 *
 * @param error - The error to classify
 * @returns `true` if the error is expected during Windows cleanup and can be safely ignored
 */
function isBestEffortCleanupError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return /\bEBUSY\b|\bEPERM\b|\bENOTEMPTY\b|\bsqlite_busy\b|\bdatabase is locked\b/i.test(
    `${code} ${message}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Removes a temp directory with exponential-backoff retries for Windows
 * SQLite handle-release latency, capped by a wallclock budget.
 *
 * `fs.rm`'s built-in `maxRetries`/`retryDelay` can stall for many seconds
 * when a SQLite/libsql handle hasn't drained, or when the panel's copilot
 * subdir holds OS-locked files. We bound the total time spent so an
 * `afterEach` hook can never exceed its timeout — residual leaks are
 * tolerable (the OS reclaims tmpdir), a thrown hook is not.
 *
 * @param dirPath - Directory to remove; must live under `os.tmpdir()`.
 * @param budgetMs - Maximum wallclock time to spend retrying.
 */
async function removeDir(dirPath: string, budgetMs = 5_000): Promise<void> {
  const tempRoot = normalizeTempPath(await fs.realpath(os.tmpdir()));
  const candidatePath = normalizeTempPath(await fs.realpath(dirPath).catch(() => dirPath));
  const tempPrefix = `${tempRoot}${path.sep}`;

  if (!candidatePath.startsWith(tempPrefix)) {
    throw new Error(`Refusing to delete non-temp path: ${dirPath}`);
  }

  const deadline = Date.now() + budgetMs;
  const backoffsMs: readonly number[] = [100, 250, 500, 1000];
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
      return;
    } catch (error: unknown) {
      lastError = error;
      if (!isBestEffortCleanupError(error)) {
        throw error;
      }
      const delay = backoffsMs[Math.min(attempt, backoffsMs.length - 1)] ?? 1000;
      attempt += 1;
      if (Date.now() + delay >= deadline) {
        break;
      }
      await sleep(delay);
    }
  }

  // Budget exhausted on a best-effort error; intentionally swallow to
  // avoid failing the test hook. The temp dir leaks but the OS will
  // eventually reclaim it (tmpdir is process- or boot-scoped).
  void lastError;
}

export async function createE2EContext(): Promise<E2EContext> {
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  const testHome = await mkCanonicalTempDir("council-e2e-");
  const testDataHome = await mkCanonicalTempDir("council-e2e-data-");

  try {
    // These helpers mutate process.env, so E2E suites must avoid overlapping contexts in one process.
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

  // We do not call `waitForDbRelease` here: it only confirms a new
  // connection can be opened, it does not force a leaked connection to
  // release its file handle. `removeDir`'s exponential backoff is the
  // actual mechanism that absorbs Windows EBUSY/EPERM during teardown.
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

export async function destroyTestDb(db: CouncilDatabase): Promise<void> {
  try {
    await db.destroy();
  } catch (error: unknown) {
    if (!isBestEffortCleanupError(error)) {
      throw error;
    }

    // best-effort: Windows may still be unwinding SQLite/libsql handles
  }
}

/**
 * Polls until the test database is fully released and can be reopened/closed.
 *
 * **Use case:**
 * After a command completes, Windows may hold SQLite file handles for a brief
 * period. This helper polls with generous timeouts (10s on Windows, 2s elsewhere)
 * to avoid flakes in E2E tests that need to verify database state.
 *
 * **Implementation:**
 * Uses `expect.poll` to repeatedly attempt opening and closing the database.
 * Resolves once successful, or throws after timeout if the database
 * remains locked.
 *
 * @param testHome - Path to test home directory containing `council.db`
 */
export async function waitForDbRelease(testHome: string): Promise<void> {
  const { expect } = await import("vitest");
  const { DatabaseSync } = await import("node:sqlite");

  function isDbReleased(): boolean {
    let database: InstanceType<typeof DatabaseSync> | undefined;
    try {
      database = new DatabaseSync(path.join(testHome, "council.db"));
      // Use a write-side probe: BEGIN IMMEDIATE acquires a RESERVED lock,
      // confirming the previous test has fully released its write handle.
      // A read-only SELECT 1 would succeed even with a pending writer.
      database.exec("BEGIN IMMEDIATE");
      database.exec("ROLLBACK");
      return true;
    } catch {
      // Any open/probe failure (lock, transient error, etc.) means
      // not-yet-released; keep polling until the outer timeout fires.
      return false;
    } finally {
      if (database !== undefined) {
        try {
          database.close();
        } catch {
          // best-effort: handle may still be unwinding
        }
      }
    }
  }

  const timeout = process.platform === "win32" ? 10_000 : 2_000;

  await expect
    .poll(() => isDbReleased(), {
      interval: 50,
      timeout,
    })
    .toBe(true);
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
    await destroyTestDb(db);
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
    await destroyTestDb(db);
  }
}

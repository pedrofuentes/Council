/**
 * Track 3 — observability + ratchet tests (#119, #120, #121, #138).
 *
 * RED at this commit:
 * - #119: DebatePersister silently drops `turn.end` events without a
 *   matching `turn.start`. Should warn via injectable logger so
 *   orchestrator protocol violations are detectable.
 * - #120: DebatePersister has no single-use enforcement. Calling
 *   persist() twice on the same instance silently overwrites
 *   #debateId and carries pending-turn state across debates. Should
 *   throw on second persist() entry.
 * - #121: reasonToStatus mapping is only tested for 'completed' via
 *   the freeform debate path. Add direct unit coverage for all 5
 *   DebateEndReason values via the persister's debate.end branch.
 * - #138: convene's cleanup-error logging (engine.stop / db.destroy
 *   rejections) has no regression test — a future revert to silent
 *   .catch(() => undefined) wouldn't be caught.
 *
 * RED again at the #163 follow-up commit:
 * - #163: the #119 orphan `turn.end` warning logs only the offending
 *   slug. With multiple concurrent debates, ops can't tell which debate
 *   row a warning belongs to. The message should also embed debateId
 *   (and the turnId from the orphan event).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DebateEndReason, DebateEvent } from "../../src/core/types.js";
import type { ExpertSpec } from "../../src/engine/index.js";
import { MockEngine } from "../../src/engine/mock/mock-engine.js";

import { createDatabase, type CouncilDatabase } from "../../src/memory/db.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";
import {
  DebatePersister,
  type DebatePersisterLogger,
} from "../../src/memory/persister.js";

import { buildConveneCommand } from "../../src/cli/commands/convene.js";

const cto: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

// ────────────────────────────────────────────────────────────────────────
// Shared persister fixture for #119, #120, #121
// ────────────────────────────────────────────────────────────────────────

interface PersisterFixture {
  db: CouncilDatabase;
  panelId: string;
  expertId: string;
  debateRepo: DebateRepository;
  turnRepo: TurnRepository;
}

async function makeFixture(): Promise<PersisterFixture> {
  const db = await createDatabase(":memory:");
  const panel = await new PanelRepository(db).create({
    name: "p",
    copilotHome: "test-copilot-home",
    configJson: "{}",
  });
  const expert = await new ExpertRepository(db).create({
    panelId: panel.id,
    slug: cto.slug,
    displayName: cto.displayName,
    model: cto.model,
    systemMessage: cto.systemMessage,
  });
  return {
    db,
    panelId: panel.id,
    expertId: expert.id,
    debateRepo: new DebateRepository(db),
    turnRepo: new TurnRepository(db),
  };
}

async function teardownFixture(f: PersisterFixture): Promise<void> {
  await f.db.destroy();
}

// ────────────────────────────────────────────────────────────────────────
// #119 — warn on turn.end without prior turn.start
// ────────────────────────────────────────────────────────────────────────

describe("DebatePersister #119 — warn on turn.end without prior turn.start", () => {
  let f: PersisterFixture;

  beforeEach(async () => {
    f = await makeFixture();
  });
  afterEach(async () => {
    await teardownFixture(f);
  });

  it("calls logger.warn when turn.end arrives with no matching turn.start", async () => {
    const warn = vi.fn();
    const logger: DebatePersisterLogger = { warn };
    const persister = new DebatePersister({
      debates: f.debateRepo,
      turns: f.turnRepo,
      panelId: f.panelId,
      expertSlugToId: { [cto.slug]: f.expertId },
      moderator: "round-robin",
      logger,
    });

    async function* protocolViolation(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      // Note: NO turn.start — protocol violation.
      yield {
        kind: "turn.end",
        expertSlug: cto.slug,
        turnId: "01HX",
        content: "orphan turn",
      };
      yield { kind: "debate.end", reason: "completed" };
    }

    for await (const _ of persister.persist(protocolViolation(), "topic")) {
      /* drain */
    }

    expect(warn).toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message.toLowerCase()).toMatch(/turn\.end|turn.start|protocol/);
    expect(message).toContain(cto.slug);
  });

  it("includes debateId and turnId in the orphan turn.end warning message (#163)", async () => {
    const warn = vi.fn();
    const logger: DebatePersisterLogger = { warn };
    const persister = new DebatePersister({
      debates: f.debateRepo,
      turns: f.turnRepo,
      panelId: f.panelId,
      expertSlugToId: { [cto.slug]: f.expertId },
      moderator: "round-robin",
      logger,
    });

    async function* protocolViolation(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      // Note: NO turn.start — protocol violation.
      yield {
        kind: "turn.end",
        expertSlug: cto.slug,
        turnId: "01HX-orphan-turn",
        content: "orphan turn",
      };
      yield { kind: "debate.end", reason: "completed" };
    }

    for await (const _ of persister.persist(protocolViolation(), "topic")) {
      /* drain */
    }

    // #debateId is assigned synchronously on persist() entry — before any
    // event is processed — so it is always defined by the time the orphan
    // turn.end warning below fires.
    expect(persister.debateId).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    // Discriminating oracle: assert the ACTUAL debateId value produced by
    // this run is embedded in the warning — not merely that warn fired.
    // Multiple concurrent debates each get their own debateId, so ops need
    // this to correlate a warning back to a specific debate row (#163).
    expect(message).toContain(`debateId='${persister.debateId}'`);
    expect(message).toContain("01HX-orphan-turn");
    expect(message).toContain(cto.slug);
    expect(message).toContain("no matching turn.start");
  });

  it("does NOT warn on the normal turn.start → turn.end sequence", async () => {
    const warn = vi.fn();
    const persister = new DebatePersister({
      debates: f.debateRepo,
      turns: f.turnRepo,
      panelId: f.panelId,
      expertSlugToId: { [cto.slug]: f.expertId },
      moderator: "round-robin",
      logger: { warn },
    });

    async function* normalSequence(): AsyncIterable<DebateEvent> {
      yield { kind: "turn.start", expertSlug: cto.slug, round: 0, seq: 0 };
      yield { kind: "turn.end", expertSlug: cto.slug, turnId: "01HX", content: "hi" };
      yield { kind: "debate.end", reason: "completed" };
    }

    for await (const _ of persister.persist(normalSequence(), "topic")) {
      /* drain */
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// #120 — enforce single-use semantics (throw on second persist())
// ────────────────────────────────────────────────────────────────────────

describe("DebatePersister #120 — single-use semantics", () => {
  let f: PersisterFixture;

  beforeEach(async () => {
    f = await makeFixture();
  });
  afterEach(async () => {
    await teardownFixture(f);
  });

  it("throws on a second persist() call on the same instance", async () => {
    const persister = new DebatePersister({
      debates: f.debateRepo,
      turns: f.turnRepo,
      panelId: f.panelId,
      expertSlugToId: {},
      moderator: "round-robin",
    });

    async function* trivial(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "debate.end", reason: "completed" };
    }

    // First persist() drains normally.
    for await (const _ of persister.persist(trivial(), "topic-1")) {
      /* drain */
    }
    expect(persister.debateId).toBeDefined();
    const firstDebateId = persister.debateId;

    // Second persist() must reject with a clear single-use error.
    let thrownMessage = "";
    try {
      for await (const _ of persister.persist(trivial(), "topic-2")) {
        /* drain */
      }
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    expect(thrownMessage.toLowerCase()).toMatch(/single-use|already|reuse|once/);
    // First debate id must not have been overwritten.
    expect(persister.debateId).toBe(firstDebateId);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #121 — reasonToStatus mapping covers all DebateEndReason values
// ────────────────────────────────────────────────────────────────────────

describe("DebatePersister #121 — reasonToStatus mapping", () => {
  let f: PersisterFixture;

  beforeEach(async () => {
    f = await makeFixture();
  });
  afterEach(async () => {
    await teardownFixture(f);
  });

  // Test matrix: each DebateEndReason -> expected debates.status.
  const cases: { reason: DebateEndReason; status: string }[] = [
    { reason: "completed", status: "completed" },
    { reason: "consensus", status: "completed" },
    { reason: "limit", status: "completed" },
    { reason: "aborted", status: "aborted" },
    { reason: "failed", status: "failed" },
  ];

  for (const c of cases) {
    it(`maps reason='${c.reason}' to debates.status='${c.status}'`, async () => {
      const persister = new DebatePersister({
        debates: f.debateRepo,
        turns: f.turnRepo,
        panelId: f.panelId,
        expertSlugToId: {},
        moderator: "round-robin",
      });

      async function* withReason(): AsyncIterable<DebateEvent> {
        yield { kind: "panel.assembled", experts: [] };
        yield { kind: "debate.end", reason: c.reason };
      }

      for await (const _ of persister.persist(withReason(), "t")) {
        /* drain */
      }

      const debate = await f.debateRepo.findById(persister.debateId ?? "");
      expect(debate?.status).toBe(c.status);
      expect(debate?.endedAt).not.toBeNull();
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// #138 — convene cleanup-error logging regression test
// ────────────────────────────────────────────────────────────────────────

describe("convene #138 — cleanup-error logging regression test", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-track3-138-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
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

  it("writes engine.stop() failure to writeError during cleanup", async () => {
    let stderrCaptured = "";

    const cmd = buildConveneCommand({
      engineFactory: () => {
        const e = new MockEngine();
        // Override stop() to reject. removeExpert + addExpert keep
        // their normal behavior so the convene flow reaches the
        // finally block naturally.
        const origStop = e.stop.bind(e);
        e.stop = async (): Promise<void> => {
          await origStop();
          throw new Error("simulated stop failure");
        };
        return e;
      },
      write: () => undefined,
      writeError: (s) => {
        stderrCaptured += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic",
      "--template",
      "code-review",
      "--engine",
      "mock",
      "--max-rounds",
      "1",
    ]);

    expect(stderrCaptured).toMatch(/engine\.stop\(\) failed during cleanup/);
    expect(stderrCaptured).toMatch(/simulated stop failure/);
  });
});

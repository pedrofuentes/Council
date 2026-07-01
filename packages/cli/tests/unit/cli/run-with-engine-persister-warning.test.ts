/**
 * Integration test: DebatePersister warning routes to writeError via
 * runWithEngine (#813).
 *
 * Sentinel finding F4 (SEN-PR804-d9c2112): the existing logger-wiring
 * test proves a logger object is INJECTED but manually calls warn() on the
 * captured object. This test instead triggers a REAL DebatePersister warning
 * path (orphan `turn.end` with no prior `turn.start`) and asserts the actual
 * warning message reaches the `writeError` sink — discriminating on the
 * exact text emitted by DebatePersister, not on a manual warn() call.
 *
 * Technique: stub `Debate.prototype.run` to emit an orphan `turn.end` event;
 * the REAL DebatePersister processes the stream, detects the orchestrator
 * protocol violation, and calls `logger.warn()` — which `runWithEngine` wires
 * to `writeError` via `!! <message>\n`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyTemplateDb } from "../../helpers/template-db.js";
import { runWithEngine } from "../../../src/cli/run-with-engine.js";
import { Debate } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";

const expert: ExpertSpec = {
  id: "placeholder",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

describe("runWithEngine — DebatePersister warning routing to writeError (#813)", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelId: string;
  let expertSlugToId: Record<string, string>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-persister-warn-"));
    await copyTemplateDb(path.join(dir, "council.db"));
    db = await createDatabase(path.join(dir, "council.db"));
    const panel = await new PanelRepository(db).create({
      name: "p",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;
    const e = await new ExpertRepository(db).create({
      panelId,
      slug: expert.slug,
      displayName: expert.displayName,
      model: expert.model,
      systemMessage: expert.systemMessage,
    });
    expertSlugToId = { [expert.slug]: e.id };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("routes a real DebatePersister orphan-turn.end warning to writeError", async () => {
    // Stub Debate.prototype.run to emit an orphan turn.end (no prior
    // turn.start for slug 'cto'). The REAL DebatePersister processes this
    // stream, detects the missing turn.start in #persistTurn, and calls
    // logger.warn() — which runWithEngine wires to writeError as `!! <msg>\n`.
    // This is the discriminating integration signal: the warning flows from
    // the persister's own protocol-violation detection, not from a manual
    // warn() call on a captured logger.
    vi.spyOn(Debate.prototype, "run").mockImplementation(
      function (this: Debate): AsyncIterable<DebateEvent> {
        return (async function* (): AsyncGenerator<DebateEvent, void, void> {
          yield { kind: "panel.assembled", experts: [] };
          yield { kind: "round.start", round: 1 };
          // Orphan turn.end: no prior turn.start for 'cto' this round.
          // DebatePersister detects this and emits the protocol-violation warn.
          yield {
            kind: "turn.end",
            expertSlug: "cto",
            turnId: "orphan-turn-id-813",
            content: "orphan response",
            speakerKind: "expert",
          };
          yield { kind: "debate.end", reason: "completed" };
        })();
      },
    );

    let errOutput = "";
    await runWithEngine({
      engineKind: "mock",
      engineFactory: () => new MockEngine(),
      experts: [{ ...expert, id: expertSlugToId[expert.slug] ?? "" }],
      debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
      prompt: "Should we ship?",
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      format: "json",
      write: () => undefined,
      writeError: (s: string) => {
        errOutput += s;
      },
      db,
    });

    // Discriminating oracle: assert the ACTUAL warning text emitted by
    // DebatePersister#persistTurn, not just "warn was called". The message
    // must contain the slug, the specific turnId supplied above, and the
    // human-readable protocol-violation description.
    expect(errOutput).toContain("DebatePersister: turn.end for slug='cto'");
    expect(errOutput).toContain("turnId='orphan-turn-id-813'");
    expect(errOutput).toContain("has no matching turn.start");
    expect(errOutput).toContain("orchestrator protocol violation");
  });
});

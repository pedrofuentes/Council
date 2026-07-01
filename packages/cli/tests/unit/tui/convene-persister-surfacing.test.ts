import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../src/core/types.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { DebatePersister } from "../../../src/memory/persister.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";
import { createPersisterLogger, type ConveneViewEvent } from "../../../src/tui/adapters/convene.js";
import { copyTemplateDb } from "../../helpers/template-db.js";

// Combines every terminal-injection vector from #1663 inside the untrusted slug
// that the persister echoes verbatim into its warning text.
const ADVERSARIAL =
  "cto\u001B[31mANSI\u009BC1\rCR\nLF\u2028LS\u2029PS\tTAB\u202Ebidi\u2066iso\u200Bzw";

const TERMINAL_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

async function makeDatabase(): Promise<{ readonly db: CouncilDatabase; readonly dir: string }> {
  const root = path.join(process.cwd(), ".tmp-convene-surfacing-test-");
  const dir = await fs.mkdtemp(root);
  const dbPath = path.join(dir, "council.db");
  await copyTemplateDb(dbPath);
  const db = await createDatabase(dbPath);
  await db
    .insertInto("panels")
    .values({
      id: "panel-1",
      name: "launch-panel",
      topic: "Launch",
      copilot_home: ".council",
      config_json: "{}",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  return { db, dir };
}

describe("createPersisterLogger — DebatePersister warning surfacing", () => {
  let db: CouncilDatabase;
  let dir: string;

  beforeEach(async () => {
    const created = await makeDatabase();
    db = created.db;
    dir = created.dir;
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("surfaces a real DebatePersister orphan-turn warning as a sanitized single-line error view event", async () => {
    const events: ConveneViewEvent[] = [];
    const persister = new DebatePersister({
      debates: new DebateRepository(db),
      turns: new TurnRepository(db),
      panelId: "panel-1",
      expertSlugToId: {},
      moderator: "round-robin",
      logger: createPersisterLogger((event) => events.push(event)),
    });

    // A turn.end with no matching turn.start is a real orchestrator protocol
    // violation: the persister calls logger.warn(...) with the offending slug
    // embedded verbatim. The slug carries adversarial bytes, so the surfaced
    // error view event must be sanitized.
    async function* orphanSource(): AsyncGenerator<DebateEvent> {
      yield {
        kind: "turn.end",
        expertSlug: ADVERSARIAL,
        turnId: "turn-orphan",
        content: "orphaned content",
      };
      yield { kind: "debate.end", reason: "completed" };
    }

    for await (const _evt of persister.persist(orphanSource(), "topic")) {
      // drain the stream so the persister processes every event
    }

    const errorEvents = events.filter(
      (event): event is Extract<ConveneViewEvent, { kind: "error" }> => event.kind === "error",
    );
    expect(errorEvents).toHaveLength(1);
    const message = errorEvents[0]?.message ?? "";
    // The warning actually fired (not just a logger constructed) ...
    expect(message).toContain("no matching turn.start");
    // ... and the untrusted slug it echoed is single-line and control-free.
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
  });
});

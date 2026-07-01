/**
 * Wiring regression for #1663 (fix 3): `streamDebate` must construct its
 * `DebatePersister` with a logger that surfaces protocol-violation warnings as
 * SANITIZED convene error view events. Without the logger, persister warnings
 * are silently swallowed (the pre-fix behavior).
 *
 * The persister is mocked so the test can (a) capture the exact `deps.logger`
 * that `streamDebate` passes and (b) prove that invoking it routes a sanitized,
 * single-line error view event to the caller's `onEvent` — not merely that a
 * logger object was constructed.
 */
import { describe, expect, it, vi } from "vitest";

import type { DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { CouncilEngine, ExpertSpec } from "../../../src/engine/index.js";
import type { CouncilDatabase } from "../../../src/memory/db.js";
import type { DebatePersisterDeps } from "../../../src/memory/persister.js";
import {
  createConveneSource,
  type ConveneViewEvent,
  type ResolvedConvenePanel,
} from "../../../src/tui/adapters/convene.js";
import { ScriptedEngine } from "../../helpers/scripted-engine.js";

const { capturedDeps } = vi.hoisted(() => ({
  capturedDeps: [] as DebatePersisterDeps[],
}));

vi.mock("../../../src/memory/persister.js", () => {
  class MockDebatePersister {
    constructor(deps: DebatePersisterDeps) {
      capturedDeps.push(deps);
    }

    get debateId(): string | undefined {
      return "mock-debate";
    }

    async *persist(source: AsyncIterable<DebateEvent>): AsyncIterable<DebateEvent> {
      // The wiring test only needs the captured logger, so the real debate
      // source is deliberately left un-iterated and no events are yielded.
      void source;
      await Promise.resolve();
    }
  }

  return { DebatePersister: MockDebatePersister };
});

// A warning whose untrusted slug carries every terminal-injection vector from
// #1663: ANSI CSI, C1 CSI (U+009B), CR/LF, U+2028/U+2029, a bidi override and a
// bidi isolate.
const ADVERSARIAL_WARNING =
  "DebatePersister: turn.end for slug='evil\u001B[31m\u009B\r\n\u2028\u2029\u202E\u2066' has no matching turn.start";

const TERMINAL_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

const expert: ExpertSpec = {
  id: "expert-cto",
  slug: "cto",
  displayName: "CTO",
  model: "scripted",
  systemMessage: "You are the CTO.",
};

const debateConfig: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [],
};

const panel: ResolvedConvenePanel = {
  experts: [expert],
  debateConfig,
  panelId: "panel-1",
  expertSlugToId: { cto: expert.id },
  moderator: "round-robin",
  mode: "freeform",
  phaseCount: 1,
};

describe("streamDebate — DebatePersister logger wiring", () => {
  it("passes the persister a logger that surfaces warnings as sanitized error view events", async () => {
    capturedDeps.length = 0;
    const events: ConveneViewEvent[] = [];
    const engine: CouncilEngine = new ScriptedEngine({ scripts: {} });
    const source = createConveneSource({
      db: {} as unknown as CouncilDatabase,
      engineFactory: () => engine,
      resolvePanel: async (): Promise<ResolvedConvenePanel> => panel,
    });

    await source.streamDebate("launch-panel", "Ship it?", {}, (event) => {
      events.push(event);
    });

    // streamDebate must have wired a logger into the persister.
    expect(capturedDeps).toHaveLength(1);
    const logger = capturedDeps[0]?.logger;
    expect(logger).toBeDefined();
    // The mock persister yields nothing, so no events until the logger fires.
    expect(events).toHaveLength(0);

    logger?.warn(ADVERSARIAL_WARNING);

    // A persister warning actually produced a sanitized error view event.
    expect(events).toHaveLength(1);
    const surfaced = events[0];
    expect(surfaced?.kind).toBe("error");
    const message = surfaced?.kind === "error" ? surfaced.message : "";
    expect(message).toContain("no matching turn.start");
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
  });
});

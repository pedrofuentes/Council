/**
 * Integration tests for `council convene --engine copilot`.
 *
 * These tests exercise the REAL Copilot adapter — they will start a
 * `CopilotClient`, authenticate, create sessions, and stream a one-round
 * debate. They cost real tokens and need network access.
 *
 * **Skipped by default.** Set `COUNCIL_INTEGRATION=1` to opt in.
 *
 * Why an env-var gate, not a separate runner:
 *   - keeps the test file co-located with the rest of the suite
 *   - one `pnpm test` command for unit + (optionally) integration
 *   - matches the "config/test" convention used elsewhere in vitest
 *
 * The integration suite assumes the user has already authenticated the
 * Copilot SDK (e.g. via `gh auth login` + a recent `copilot` invocation).
 * If auth is missing the test fails with a NOT_AUTHENTICATED error from
 * the engine — that is the intended signal, not a bug.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyTemplateDb } from "../helpers/template-db.js";
import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import { createDatabase } from "../../src/memory/db.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";

const INTEGRATION = process.env["COUNCIL_INTEGRATION"] === "1";

describe.runIf(INTEGRATION)("council convene --engine copilot (integration)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-integration-"));
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

  it(
    "runs a 1-round debate against the real Copilot SDK and persists turns",
    async () => {
      let captured = "";
      const cmd = buildConveneCommand({
        write: (s) => {
          captured += s;
        },
      });

      await cmd.parseAsync([
        "node",
        "council-convene",
        "What is one risk of shipping an MVP without observability?",
        "--template",
        "code-review",
        "--max-rounds",
        "1",
        "--max-words",
        "60",
        "--format",
        "json",
        "--engine",
        "copilot",
      ]);

      const db = await createDatabase(path.join(testHome, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        const debates = await new DebateRepository(db).findByPanelId(panels[0]?.id ?? "");
        expect(debates).toHaveLength(1);
        expect(debates[0]?.status).toBe("completed");
        const turns = await new TurnRepository(db).findByDebateId(debates[0]?.id ?? "");
        expect(turns.length).toBeGreaterThan(0);
        for (const t of turns) {
          expect(t.content.length).toBeGreaterThan(0);
        }
      } finally {
        await db.destroy();
      }

      const lines = captured
        .split("\n")
        .filter((l) => l.trim().length > 0 && l.trim().startsWith("{"));
      const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
      expect(kinds).toContain("turn.end");
      expect(kinds[kinds.length - 1]).toBe("debate.end");
    },
    // Real Copilot calls take ≥10s per turn × N experts; allow 90s.
    90_000,
  );
});

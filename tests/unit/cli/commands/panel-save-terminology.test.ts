/**
 * T9 — terminology alignment. The convene/auto-compose continuity gap is
 * also a wording gap: `council sessions` and `council chat` must make the
 * "panels are reusable library templates; sessions are individual debate
 * runs" distinction explicit and point users at `council panel save`.
 *
 * RED at this commit: the sessions footer and chat help do not mention
 * `council panel save`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSessionsCommand } from "../../../../src/cli/commands/sessions.js";
import { buildChatCommand } from "../../../../src/cli/commands/chat/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

describe("T9 terminology — sessions footer", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-t9-term-"));
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

  it("footer points users at `council panel save` to promote a session", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      await new PanelRepository(db).create({
        name: "auto-panel-2026-06-15T12:00:00",
        topic: "topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: "{}",
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildSessionsCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-sessions"]);

    // Preserve the existing distinction wording + panel list pointer.
    expect(captured).toContain("council panel list");
    expect(captured).toMatch(/templates/i);
    // New: surface the save path so a run-scoped panel can be kept.
    expect(captured).toContain("council panel save");
  });
});

describe("T9 terminology — chat help", () => {
  it("chat help explains panels come from the library and how to save one", () => {
    // Commander's outputHelp() renders the full help including addHelpText
    // sections, unlike helpInformation() which omits them (see
    // expert-persona-ux.test.ts for the same distinction).
    const cmd = buildChatCommand();
    let output = "";
    cmd.configureOutput({
      writeOut: (str) => {
        output += str;
      },
    });
    cmd.outputHelp();
    expect(output).toContain("council panel save");
  });
});

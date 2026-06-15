/**
 * Test for T16 — panel delete confirmation should state debate session count.
 *
 * Verifies that the confirmation message for `council panel delete <name>`
 * includes the count of debate sessions that will be permanently deleted.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { buildDeleteConfirmationMessage } from "../../../../src/cli/commands/panel.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-count-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-count-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: {
      weightedEvidence: ["evidence"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Empirical",
    kind: "generic",
  };
}

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function createPanel(env: TestEnv, name: string, experts: readonly string[]): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync([
    "node",
    "council-panel",
    "create",
    name,
    "--experts",
    experts.join(","),
    "--mode",
    "freeform",
  ]);
}

async function createDebateSession(env: TestEnv, panelName: string): Promise<string> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
  const { DebateRepository } = await import("../../../../src/memory/repositories/debates.js");

  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const debateRepo = new DebateRepository(db);

    const panel = await panelRepo.findByName(panelName);
    if (!panel) {
      throw new Error(`Panel "${panelName}" not found`);
    }

    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Test debate prompt",
      moderator: "test-moderator",
    });

    return debate.id;
  } finally {
    await db.destroy();
  }
}

describe("buildDeleteConfirmationMessage (T16)", () => {
  it("returns a message with debate count when N > 0", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 3);
    expect(msg).toMatch(/my-panel/);
    expect(msg).toMatch(/3 debate session/);
    expect(msg).toMatch(/cannot be undone/i);
  });

  it("returns a message without debate count clause when N = 0", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 0);
    expect(msg).toMatch(/my-panel/);
    expect(msg).not.toMatch(/0 debate/);
    expect(msg).not.toMatch(/session/);
    expect(msg).toMatch(/cannot be undone/i);
  });

  it("uses singular 'session' for N = 1", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 1);
    expect(msg).toMatch(/1 debate session/);
    expect(msg).not.toMatch(/sessions/);
  });

  it("uses plural 'sessions' for N > 1", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 2);
    expect(msg).toMatch(/2 debate sessions/);
  });
});

describe("panel delete confirmation with debate count (T16 integration)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("confirmation message includes debate count when panel has N > 0 debates", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "active-panel", ["cto"]);
    await createDebateSession(env, "active-panel");
    await createDebateSession(env, "active-panel");
    await createDebateSession(env, "active-panel");

    let confirmMessage = "";
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
      {
        confirm: async (msg) => {
          confirmMessage = msg;
          return false;
        },
      },
    );

    await expect(
      cmd.parseAsync(["node", "council-panel", "delete", "active-panel"]),
    ).rejects.toThrow();

    expect(confirmMessage).toMatch(/active-panel/);
    expect(confirmMessage).toMatch(/3 debate session/);
    expect(confirmMessage).toMatch(/permanently delete/);
    expect(confirmMessage).toMatch(/cannot be undone/i);
  });

  it("confirmation message omits debate clause when panel has 0 debates", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "empty-panel", ["cto"]);

    let confirmMessage = "";
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
      {
        confirm: async (msg) => {
          confirmMessage = msg;
          return false;
        },
      },
    );

    await expect(
      cmd.parseAsync(["node", "council-panel", "delete", "empty-panel"]),
    ).rejects.toThrow();

    expect(confirmMessage).toMatch(/empty-panel/);
    expect(confirmMessage).not.toMatch(/0 debate/);
    expect(confirmMessage).not.toMatch(/session/);
    expect(confirmMessage).toMatch(/cannot be undone/i);
  });
});

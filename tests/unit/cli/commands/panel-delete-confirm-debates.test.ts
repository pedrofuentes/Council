/**
 * Tests for T16 — `council panel delete` confirmation must accurately
 * describe what is removed.
 *
 * `panel delete` removes ONLY the panel template: the `panel_library` row,
 * its `panel_members`, the YAML file, and the panel docs directory. It does
 * NOT delete debate sessions — those live in the runtime `panels`/`debates`
 * tables, which have no foreign key to `panel_library`. The confirmation
 * message must therefore frame any existing debate sessions as KEPT (still
 * available via `council sessions`), and the destructive (confirm → true)
 * path must leave those sessions intact.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDeleteConfirmationMessage,
  buildPanelCommand,
} from "../../../../src/cli/commands/panel.js";
import type { CouncilDatabase } from "../../../../src/memory/db.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

function noop(): void {
  /* swallow command output */
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-keep-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-del-keep-data-"));
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

async function withDb<T>(env: TestEnv, fn: (db: CouncilDatabase) => Promise<T>): Promise<T> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    return await fn(db);
  } finally {
    await db.destroy();
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
  const cmd = buildPanelCommand(noop, noop);
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
  return withDb(env, async (db) => {
    const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
    const { DebateRepository } = await import("../../../../src/memory/repositories/debates.js");

    const panelRepo = new PanelRepository(db);
    const debateRepo = new DebateRepository(db);

    // Find or create the runtime panel instance that owns debate sessions
    // (normally created by the debate orchestrator when a debate starts).
    let panel = await panelRepo.findByName(panelName);
    if (!panel) {
      panel = await panelRepo.create({
        name: panelName,
        copilotHome: env.home,
        configJson: "{}",
      });
    }

    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Test debate prompt",
      moderator: "test-moderator",
    });

    return debate.id;
  });
}

describe("buildDeleteConfirmationMessage (T16)", () => {
  it("frames debate sessions as kept (not deleted) when N > 0", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 3);
    expect(msg).toMatch(/^Delete panel "my-panel" and its documents\?/);
    expect(msg).toMatch(/3 past debate sessions are kept/);
    expect(msg).toMatch(/stay available via 'council sessions'/);
    expect(msg).toMatch(/cannot be undone/i);
    // Must NOT claim the debate sessions are deleted (the rejected bug).
    expect(msg).not.toMatch(/permanently/i);
    expect(msg).not.toMatch(/also.*delete/i);
  });

  it("omits the debate clause entirely when N = 0", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 0);
    expect(msg).toMatch(/^Delete panel "my-panel" and its documents\?/);
    expect(msg).toMatch(/cannot be undone/i);
    expect(msg).not.toMatch(/debate/i);
    expect(msg).not.toMatch(/session/i);
    expect(msg).not.toMatch(/kept/i);
  });

  it("uses singular noun and verbs for N = 1", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 1);
    expect(msg).toMatch(/1 past debate session is kept and stays available/);
    expect(msg).not.toMatch(/debate sessions/);
  });

  it("uses plural noun and verbs for N > 1", () => {
    const msg = buildDeleteConfirmationMessage("my-panel", 2);
    expect(msg).toMatch(/2 past debate sessions are kept and stay available/);
  });
});

describe("panel delete confirmation accuracy (T16 integration)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("frames existing debate sessions as kept when N > 0 (declined)", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "active-panel", ["cto"]);
    await createDebateSession(env, "active-panel");
    await createDebateSession(env, "active-panel");
    await createDebateSession(env, "active-panel");

    let confirmMessage = "";
    const cmd = buildPanelCommand(noop, noop, {
      confirm: async (msg) => {
        confirmMessage = msg;
        return false;
      },
    });

    await expect(
      cmd.parseAsync(["node", "council-panel", "delete", "active-panel"]),
    ).rejects.toThrow();

    expect(confirmMessage).toMatch(/active-panel/);
    expect(confirmMessage).toMatch(/and its documents/);
    expect(confirmMessage).toMatch(/3 past debate sessions are kept/);
    expect(confirmMessage).toMatch(/council sessions/);
    expect(confirmMessage).toMatch(/cannot be undone/i);
    expect(confirmMessage).not.toMatch(/permanently/i);
  });

  it("omits the debate clause when the panel has 0 debate sessions (declined)", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "empty-panel", ["cto"]);

    let confirmMessage = "";
    const cmd = buildPanelCommand(noop, noop, {
      confirm: async (msg) => {
        confirmMessage = msg;
        return false;
      },
    });

    await expect(
      cmd.parseAsync(["node", "council-panel", "delete", "empty-panel"]),
    ).rejects.toThrow();

    expect(confirmMessage).toMatch(/empty-panel/);
    expect(confirmMessage).toMatch(/and its documents/);
    expect(confirmMessage).not.toMatch(/debate/i);
    expect(confirmMessage).not.toMatch(/kept/i);
    expect(confirmMessage).toMatch(/cannot be undone/i);
  });

  it("keeps debate sessions intact when the panel is actually deleted (confirm → true)", async () => {
    await seedExpert(env, expertDef("cto"));
    await createPanel(env, "active-panel", ["cto"]);
    await createDebateSession(env, "active-panel");
    await createDebateSession(env, "active-panel");
    await createDebateSession(env, "active-panel");

    // Capture the runtime panel id that owns the debate sessions.
    const panelId = await withDb(env, async (db) => {
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const runtime = await new PanelRepository(db).findByName("active-panel");
      return runtime?.id;
    });
    expect(panelId).toBeDefined();

    let confirmMessage = "";
    const cmd = buildPanelCommand(noop, noop, {
      confirm: async (msg) => {
        confirmMessage = msg;
        return true;
      },
    });

    // Confirm → true: the panel template is actually deleted.
    await cmd.parseAsync(["node", "council-panel", "delete", "active-panel"]);

    // The message that authorized the deletion must not have lied.
    expect(confirmMessage).toMatch(/kept/i);
    expect(confirmMessage).not.toMatch(/permanently/i);

    await withDb(env, async (db) => {
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const { PanelRepository } = await import("../../../../src/memory/repositories/panels.js");
      const { DebateRepository } = await import("../../../../src/memory/repositories/debates.js");

      // (a) The panel template (library row) is removed.
      const libraryPanel = await new PanelLibraryRepository(db).findByName("active-panel");
      expect(libraryPanel).toBeUndefined();

      // (b) The runtime session and its debate sessions REMAIN (kept, not deleted).
      const runtime = await new PanelRepository(db).findByName("active-panel");
      expect(runtime).toBeDefined();
      const debates = await new DebateRepository(db).findByPanelId(panelId as string);
      expect(debates).toHaveLength(3);
    });
  });
});

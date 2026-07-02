/**
 * Tests for T-18: Information Architecture improvements.
 *
 * Covers:
 *   IA-05: --format json for expert inspect and panel inspect
 *   IA-06: Synthesis/moderator turn styling in PlainRenderer
 *   IA-08: Reorder conclude output — recommendation first
 *   IA-10: Include debate ID in conclude output
 *   DX-14: Fix conclude default to most-recently-debated
 *   DX-07: Edit validation/backup
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExpertCommand } from "../../../src/cli/commands/expert.js";
import { buildPanelCommand } from "../../../src/cli/commands/panel.js";
import { buildConcludeCommand, type ConcludeOutput } from "../../../src/cli/commands/conclude.js";
import { PlainRenderer } from "../../../src/cli/renderers/plain.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../helpers/template-db.js";
import { createDatabase } from "../../../src/memory/db.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";

// ─── Helpers ───────────────────────────────────────────────────────────

const SYNTH_ID = "synthesizer-fixed-id-for-tests";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-ia-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ia-data-"));
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
  const { FileExpertLibrary } = await import("../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

class StringSink {
  text = "";
  errText = "";
  write(s: string): void {
    this.text += s;
  }
  writeError(s: string): void {
    this.errText += s;
  }
}

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

const SAMPLE_SYNTHESIS = {
  consensus: ["All agree caching is needed"],
  tensions: ["Redis vs in-memory disagreement"],
  decisionMatrix: [
    {
      dimension: "Latency",
      positions: [
        { expert: "Backend", stance: "Redis preferred" },
        { expert: "Ops", stance: "In-memory simpler" },
      ],
    },
  ],
  recommendation: "Use Redis with in-memory fallback",
  confidence: "high" as const,
};

// ─── IA-05: --format json for expert inspect ───────────────────────────

describe("IA-05: --format json for inspect commands", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("expert inspect --format json outputs valid JSON with expert fields", async () => {
    await seedExpert(env, {
      ...expertDef("json-test"),
      displayName: "JSON Test Expert",
      model: "claude-sonnet-4",
    });
    let captured = "";
    const cmd = buildExpertCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-expert", "inspect", "json-test", "--format", "json"]);

    const parsed = JSON.parse(captured.trim());
    expect(parsed.slug).toBe("json-test");
    expect(parsed.displayName).toBe("JSON Test Expert");
    expect(parsed.role).toBe("json-test role");
    expect(parsed.kind).toBe("generic");
    expect(parsed.model).toBe("claude-sonnet-4");
  });

  it("panel inspect --format json outputs valid JSON with panel fields", async () => {
    await seedExpert(env, expertDef("cto"));
    await seedExpert(env, expertDef("pm"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "json-panel",
      "--experts",
      "cto,pm",
      "--description",
      "Test panel for JSON",
    ]);

    let captured = "";
    const cmd = buildPanelCommand((s) => {
      captured += s;
    });
    await cmd.parseAsync(["node", "council-panel", "inspect", "json-panel", "--format", "json"]);

    const parsed = JSON.parse(captured.trim());
    expect(parsed.name).toBe("json-panel");
    expect(parsed.description).toBe("Test panel for JSON");
    expect(parsed.members).toBeInstanceOf(Array);
    expect(parsed.members.length).toBe(2);
  });
});

// ─── IA-06: Synthesis/moderator turn styling ───────────────────────────

describe("IA-06: Synthesis/moderator turn styling", () => {
  it("PlainRenderer uses synthesis prefix for turns in synthesis phase", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "x" }],
        },
        { kind: "round.start", round: 0, phase: "synthesis" },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: "Final conclusion here." },
        { kind: "turn.end", expertSlug: "cto", turnId: "t1", content: "Final conclusion here." },
        { kind: "round.end", round: 0, phase: "synthesis" },
      ),
    );
    const text = stripAnsi(sink.text);
    // The turn header should contain a synthesis indicator (🎯 or [Synthesis])
    // distinct from the normal expert prefix
    const turnHeaderArea = text.split("Final conclusion here.")[0] ?? "";
    expect(turnHeaderArea).toMatch(/Synthesis|🎯/);
  });

  it("PlainRenderer uses normal prefix for non-synthesis phases", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "x" }],
        },
        { kind: "round.start", round: 0, phase: "opening" },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: "Hello." },
        { kind: "turn.end", expertSlug: "cto", turnId: "t1", content: "Hello." },
        { kind: "round.end", round: 0, phase: "opening" },
      ),
    );
    const text = stripAnsi(sink.text);
    const turnHeaderArea = text.split("Hello.")[0] ?? "";
    expect(turnHeaderArea).not.toMatch(/Synthesis|🎯/);
  });
});

// ─── IA-08: Reorder conclude output ────────────────────────────────────

describe("IA-08: Reorder conclude output — recommendation first", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ia08-"));
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

  it("plain output shows recommendation before consensus and tensions", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "reorder-test",
        topic: "Test topic",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "exp",
        displayName: "Expert",
        model: "m",
        systemMessage: "sys",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Test",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: "Some content.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () =>
        new MockEngine({ responses: { [SYNTH_ID]: JSON.stringify(SAMPLE_SYNTHESIS) } }),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", "reorder-test", "--engine", "mock"]);

    const recIdx = captured.indexOf("Recommendation:");
    const consIdx = captured.indexOf("Consensus:");
    const tensIdx = captured.indexOf("Tensions:");
    const matIdx = captured.indexOf("Decision Matrix:");

    expect(recIdx).toBeGreaterThan(-1);
    expect(consIdx).toBeGreaterThan(-1);
    // Recommendation must appear BEFORE consensus, tensions, and matrix
    expect(recIdx).toBeLessThan(consIdx);
    expect(recIdx).toBeLessThan(tensIdx);
    expect(recIdx).toBeLessThan(matIdx);
  });
});

// ─── IA-10: Include debate ID in conclude output ───────────────────────

describe("IA-10: Include debate ID in conclude output", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-ia10-"));
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

  it("JSON output includes debateId and startedAt", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    let seededDebateId: string | undefined;
    let seededStartedAt: string | undefined;
    try {
      const panel = await new PanelRepository(db).create({
        name: "debate-id-test",
        topic: "Test",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "exp",
        displayName: "Expert",
        model: "m",
        systemMessage: "sys",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Test",
        moderator: "round-robin",
      });
      seededDebateId = debate.id;
      seededStartedAt = debate.startedAt;
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: "Content.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () =>
        new MockEngine({ responses: { [SYNTH_ID]: JSON.stringify(SAMPLE_SYNTHESIS) } }),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync([
      "node",
      "council-conclude",
      "debate-id-test",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    const parsed = JSON.parse(captured.trim()) as ConcludeOutput & {
      debateId?: string;
      startedAt?: string;
    };
    expect(parsed.debateId).toBe(seededDebateId);
    expect(parsed.startedAt).toBe(seededStartedAt);
  });

  it("plain output includes debate ID", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panel = await new PanelRepository(db).create({
        name: "debate-id-plain",
        topic: "Test",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });
      const expert = await new ExpertRepository(db).create({
        panelId: panel.id,
        slug: "exp",
        displayName: "Expert",
        model: "m",
        systemMessage: "sys",
      });
      const debate = await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: "Test",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expert.id,
        content: "Content.",
      });
      await new DebateRepository(db).update(debate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: () => undefined,
      engineFactory: () =>
        new MockEngine({ responses: { [SYNTH_ID]: JSON.stringify(SAMPLE_SYNTHESIS) } }),
      synthesizerId: SYNTH_ID,
    });
    await cmd.parseAsync(["node", "council-conclude", "debate-id-plain", "--engine", "mock"]);

    expect(captured).toMatch(/Debate:/i);
  });
});

// ─── DX-14: Fix conclude default to most-recently-debated ──────────────

describe("DX-14: conclude defaults to most-recently-debated panel", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-dx14-"));
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

  it("selects panel with most recent debate, not most recently created", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      // Create panel A first (older ULID)
      const panelA = await new PanelRepository(db).create({
        name: "panel-older",
        topic: "Older panel",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "t", mode: "freeform" }),
      });
      const expertA = await new ExpertRepository(db).create({
        panelId: panelA.id,
        slug: "exp-a",
        displayName: "Expert A",
        model: "m",
        systemMessage: "sys",
      });
      // Panel A has a debate started MORE RECENTLY (even though panel was created first)
      // We'll use a small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 20));
      const debateA = await new DebateRepository(db).create({
        panelId: panelA.id,
        prompt: "Debate A",
        moderator: "round-robin",
      });
      await new TurnRepository(db).create({
        debateId: debateA.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: expertA.id,
        content: "Content A.",
      });
      await new DebateRepository(db).update(debateA.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });

      // Create panel B second (newer ULID) but with NO debates
      await new PanelRepository(db).create({
        name: "panel-newer",
        topic: "Newer panel, no debates",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "t", mode: "freeform" }),
      });
    } finally {
      await db.destroy();
    }

    let captured = "";
    let errCaptured = "";
    const cmd = buildConcludeCommand({
      write: (s) => {
        captured += s;
      },
      writeError: (s) => {
        errCaptured += s;
      },
      engineFactory: () =>
        new MockEngine({ responses: { [SYNTH_ID]: JSON.stringify(SAMPLE_SYNTHESIS) } }),
      synthesizerId: SYNTH_ID,
    });
    // No panel argument — should default to panel-older (has debate)
    await cmd.parseAsync(["node", "council-conclude", "--engine", "mock", "--format", "json"]);

    const parsed = JSON.parse(captured.trim());
    expect(parsed.panelName).toBe("panel-older");
    // Should print which panel was selected to stderr
    expect(errCaptured).toMatch(/panel-older/);
  });
});

// ─── DX-07: Edit validation/backup ────────────────────────────────────

describe("DX-07: Edit creates backup before opening editor", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("expert edit creates .yaml.backup before editing", async () => {
    await seedExpert(env, expertDef("backup-test"));
    const yamlPath = path.join(env.dataHome, "experts", "backup-test.yaml");
    const backupPath = yamlPath + ".backup";

    // Use a no-op editor (just exits 0 without changing anything)
    const noopEditor = process.platform === "win32" ? "cmd /c echo." : "true";
    process.env["EDITOR"] = noopEditor;

    const cmd = buildExpertCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    await cmd.parseAsync(["node", "council-expert", "edit", "backup-test"]);

    // Backup file should have been created
    const backupExists = await fs
      .access(backupPath)
      .then(() => true)
      .catch(() => false);
    expect(backupExists).toBe(true);

    // Backup content should match original
    const original = await fs.readFile(yamlPath, "utf-8");
    const backup = await fs.readFile(backupPath, "utf-8");
    expect(backup).toBe(original);
  });

  it("panel edit creates .yaml.backup before editing", async () => {
    await seedExpert(env, expertDef("cto"));
    const createCmd = buildPanelCommand(() => {
      /* noop */
    });
    await createCmd.parseAsync([
      "node",
      "council-panel",
      "create",
      "backup-panel",
      "--experts",
      "cto",
    ]);

    const panelYamlPath = path.join(env.dataHome, "panels", "backup-panel.yaml");
    const backupPath = panelYamlPath + ".backup";

    const noopEditor = process.platform === "win32" ? "cmd /c echo." : "true";
    process.env["EDITOR"] = noopEditor;

    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );
    await cmd.parseAsync(["node", "council-panel", "edit", "backup-panel"]);

    const backupExists = await fs
      .access(backupPath)
      .then(() => true)
      .catch(() => false);
    expect(backupExists).toBe(true);
  });
});

// ─── IA-05 format validation ────────────────────────────────────────────────
describe("IA-05: --format validation", () => {
  it("expert inspect rejects unknown format values", async () => {
    const { buildExpertCommand } = await import("../../../src/cli/commands/expert.js");
    const { createDatabase } = await import("../../../src/memory/db.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-fmt-val-"));
    const dataHome = path.join(tmpDir, "data");
    await fs.mkdir(path.join(dataHome, "experts"), { recursive: true });
    const dbPath = path.join(tmpDir, "council.db");
    await copyTemplateDb(dbPath);
    const db = await createDatabase(dbPath);
    const { FileExpertLibrary } = await import("../../../src/core/expert-library.js");
    const lib = new FileExpertLibrary(dataHome, db);
    await lib.create({
      slug: "fmt-test",
      displayName: "Fmt Test",
      role: "test",
      expertise: {
        weightedEvidence: ["x"],
        referenceCases: [],
        notExpertIn: [],
      },
      epistemicStance: "Empirical",
      kind: "generic",
    });
    await db.destroy();

    process.env["COUNCIL_HOME"] = tmpDir;
    process.env["COUNCIL_DATA_HOME"] = dataHome;
    try {
      const cmd = buildExpertCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync(["node", "council-expert", "inspect", "fmt-test", "--format", "xml"]),
      ).rejects.toThrow(/Unknown format.*xml/);
    } finally {
      delete process.env["COUNCIL_HOME"];
      delete process.env["COUNCIL_DATA_HOME"];
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
        /* noop */
      });
    }
  });

  it("panel inspect rejects unknown format values", async () => {
    const { buildPanelCommand } = await import("../../../src/cli/commands/panel.js");
    const { createDatabase } = await import("../../../src/memory/db.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-pfmt-val-"));
    const dataHome = path.join(tmpDir, "data");
    await fs.mkdir(path.join(dataHome, "experts"), { recursive: true });
    await fs.mkdir(path.join(dataHome, "panels"), { recursive: true });
    const dbPath = path.join(tmpDir, "council.db");
    await copyTemplateDb(dbPath);
    const db = await createDatabase(dbPath);
    const { FileExpertLibrary } = await import("../../../src/core/expert-library.js");
    const lib = new FileExpertLibrary(dataHome, db);
    await lib.create({
      slug: "pfmt-exp",
      displayName: "P Fmt",
      role: "test",
      expertise: {
        weightedEvidence: ["x"],
        referenceCases: [],
        notExpertIn: [],
      },
      epistemicStance: "Empirical",
      kind: "generic",
    });
    await db.destroy();

    process.env["COUNCIL_HOME"] = tmpDir;
    process.env["COUNCIL_DATA_HOME"] = dataHome;
    try {
      // Use the CLI to create the panel (handles all DB fields)
      const createCmd = buildPanelCommand(() => {
        /* noop */
      });
      await createCmd.parseAsync([
        "node",
        "council-panel",
        "create",
        "pfmt-panel",
        "--experts",
        "pfmt-exp",
      ]);

      const cmd = buildPanelCommand(() => {
        /* noop */
      });
      await expect(
        cmd.parseAsync(["node", "council-panel", "inspect", "pfmt-panel", "--format", "csv"]),
      ).rejects.toThrow(/Unknown format.*csv/);
    } finally {
      delete process.env["COUNCIL_HOME"];
      delete process.env["COUNCIL_DATA_HOME"];
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
        /* noop */
      });
    }
  });
});

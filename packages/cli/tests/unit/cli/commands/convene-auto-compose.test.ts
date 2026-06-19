/**
 * Tests for `council convene <topic>` WITHOUT `--template` — exercises
 * the auto-composition path where the engine generates a panel from the
 * topic via the meta-prompt.
 *
 * RED at this commit: convene currently makes --template a requiredOption().
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";

const validPanelJson = JSON.stringify({
  name: "auto-panel",
  description: "Auto-composed panel for the topic",
  experts: [
    {
      slug: "alpha",
      displayName: "Alpha (Skeptic)",
      role: "Skeptic",
      expertise: { weightedEvidence: ["counter-examples"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Alpha rejects claims without falsification tests.",
    },
    {
      slug: "beta",
      displayName: "Beta (Builder)",
      role: "Builder",
      expertise: { weightedEvidence: ["empirical wins"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Beta trusts what ships and runs in production.",
    },
    {
      slug: "gamma",
      displayName: "Gamma (User Voice)",
      role: "User advocate",
      expertise: { weightedEvidence: ["user studies"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Gamma weights observed user behavior over speculation.",
    },
  ],
});

/** Stub engine: first send returns the panel JSON; later sends return generic text. */
class ScriptedEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  callIndex = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.set(spec.id, spec);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["stub"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    if (!this.#experts.has(options.expertId)) {
      throw new Error(`Expert ${options.expertId} is not registered`);
    }
    const text = this.responses[this.callIndex] ?? "[default reply]";
    this.callIndex += 1;
    const expertId = options.expertId;
    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      yield { kind: "message.delta", expertId, text };
      yield {
        kind: "message.complete",
        expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

describe("buildConveneCommand — auto-compose path", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-autocompose-test-"));
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

  it("declares --template as optional (not required)", () => {
    const cmd = buildConveneCommand({ engineFactory: () => new ScriptedEngine([]) });
    const templateOpt = cmd.options.find((o) => o.long === "--template");
    expect(templateOpt).toBeDefined();
    expect(templateOpt?.mandatory).toBe(false);
  });

  it("auto-composes a panel when --template is omitted", async () => {
    let stderr = "";
    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: (s) => {
        stdout += s;
      },
      writeError: (s) => {
        stderr += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt event sourcing?",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--yes",
    ]);

    // Auto-composed banner should be in stderr
    expect(stderr).toMatch(/auto-composed/i);
    expect(stderr).toContain("auto-panel");
    expect(stderr).toContain("Alpha (Skeptic)");

    // The debate must have actually run — stdout should contain output.
    expect(stdout.length).toBeGreaterThan(0);

    // The auto-composed panel must have been persisted to the SQLite DB.
    const dbPath = path.join(testHome, "council.db");
    const db = await createDatabase(dbPath);
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels.length).toBeGreaterThan(0);
      // Panel name is template name + ISO timestamp suffix.
      expect(panels.some((p) => p.name.startsWith("auto-panel-"))).toBe(true);
      expect(panels.some((p) => p.topic === "Should we adopt event sourcing?")).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("reports a clear error when the engine returns garbage", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine(["not json"]),
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "topic",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/auto-compose|panel|template/i);
  });

  it("still uses the template path when --template IS provided", async () => {
    const cmd = buildConveneCommand({
      // No JSON needed: template path doesn't call the meta-prompt.
      engineFactory: () => new ScriptedEngine([]),
      write: () => undefined,
      writeError: () => undefined,
    });

    // Built-in template "code-review" must exist; this path should not throw.
    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);
  });

  it("strips terminal control sequences from the auto-composed panel name in the preamble", async () => {
    // An auto-composed panel name is LLM-generated and therefore untrusted.
    // The plain-format preamble must sanitize it before writing to stdout,
    // otherwise a malicious composer could emit ANSI/OSC sequences that
    // spoof prior output, set the terminal title, or emit BEL.
    const maliciousPanel = JSON.stringify({
      name: "evil\x1B[31mFAKE\x1B[0m\x1B]0;owned\x07-panel",
      description: "auto",
      experts: [
        {
          slug: "alpha",
          displayName: "Alpha",
          role: "Skeptic",
          expertise: { weightedEvidence: ["x"], referenceCases: [], notExpertIn: [] },
          epistemicStance: "Alpha rejects unfalsifiable claims.",
        },
        {
          slug: "beta",
          displayName: "Beta",
          role: "Builder",
          expertise: { weightedEvidence: ["y"], referenceCases: [], notExpertIn: [] },
          epistemicStance: "Beta trusts what ships.",
        },
      ],
    });
    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([maliciousPanel]),
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "topic",
      "--max-rounds",
      "1",
      "--format",
      "plain",
      "--engine",
      "mock",
      "--yes",
    ]);

    // The preamble line is "# <template.name>" written before the debate
    // begins. Restrict assertions to that prefix — the debate body itself
    // legitimately echoes the malicious composer reply via Alpha's response.
    const preambleEnd = stdout.indexOf("Topic: topic");
    expect(preambleEnd).toBeGreaterThan(0);
    const preamble = stdout.slice(0, preambleEnd);
    expect(preamble).not.toContain("\x1B");
    expect(preamble).not.toContain("\x07");
    expect(preamble).toMatch(/#\s+evilFAKE/);
  });
});

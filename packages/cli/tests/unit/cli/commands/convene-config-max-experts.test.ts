/**
 * Tests for T3: `config.defaults.maxExperts` is consulted as a fallback for
 * auto-compose when the `--max-experts` CLI flag is not provided.
 *
 * Precedence (highest → lowest): CLI flag > config.defaults.maxExperts >
 * auto-compose hardcoded default (5).
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

const smallPanelJson = JSON.stringify({
  name: "auto-panel",
  description: "Auto-composed panel",
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
  ],
});

class ScriptedEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  callIndex = 0;
  readonly expertSystemMessages: string[] = [];

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
    this.expertSystemMessages.push(spec.systemMessage);
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

describe("buildConveneCommand — config.defaults.maxExperts fallback (T3)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env["COUNCIL_HOME"] = originalHome;
    } else {
      delete process.env["COUNCIL_HOME"];
    }
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("uses config.defaults.maxExperts when --max-experts CLI flag is absent", async () => {
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `defaults:
  engine: mock
  maxExperts: 4
`,
      "utf-8",
    );

    const errors: string[] = [];
    const engine = new ScriptedEngine([smallPanelJson, "r1-a", "r1-b"]);

    const cmd = buildConveneCommand({
      write: () => {
        /* sink */
      },
      writeError: (s) => {
        errors.push(s);
      },
      engineFactory: () => engine,
    });

    await cmd.parseAsync(["node", "council", "convene", "topic", "--yes"], { from: "user" });

    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);
    expect(engine.expertSystemMessages.length).toBeGreaterThan(0);
    // With config maxExperts=4, minExperts is clamped to min(3, 4) = 3, giving "3-4".
    expect(engine.expertSystemMessages[0]).toContain("panel of 3-4 AI experts");
  });

  it("clamps minExperts when config.defaults.maxExperts is below the default minimum", async () => {
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `defaults:
  engine: mock
  maxExperts: 2
`,
      "utf-8",
    );

    const errors: string[] = [];
    const engine = new ScriptedEngine([smallPanelJson, "r1-a", "r1-b"]);

    const cmd = buildConveneCommand({
      write: () => {
        /* sink */
      },
      writeError: (s) => {
        errors.push(s);
      },
      engineFactory: () => engine,
    });

    await cmd.parseAsync(["node", "council", "convene", "topic", "--yes"], { from: "user" });

    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);
    expect(engine.expertSystemMessages.length).toBeGreaterThan(0);
    // config maxExperts=2 → minExperts clamped to min(3, 2) = 2 → "2-2"
    expect(engine.expertSystemMessages[0]).toContain("panel of 2-2 AI experts");
  });

  it("prefers --max-experts CLI flag over config.defaults.maxExperts", async () => {
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `defaults:
  engine: mock
  maxExperts: 6
`,
      "utf-8",
    );

    const errors: string[] = [];
    const engine = new ScriptedEngine([smallPanelJson, "r1-a", "r1-b"]);

    const cmd = buildConveneCommand({
      write: () => {
        /* sink */
      },
      writeError: (s) => {
        errors.push(s);
      },
      engineFactory: () => engine,
    });

    await cmd.parseAsync(
      ["node", "council", "convene", "topic", "--max-experts", "2", "--yes"],
      { from: "user" },
    );

    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);
    expect(engine.expertSystemMessages.length).toBeGreaterThan(0);
    // CLI=2 wins over config=6: min(3, 2) = 2 → "2-2"
    expect(engine.expertSystemMessages[0]).toContain("panel of 2-2 AI experts");
    expect(engine.expertSystemMessages[0]).not.toContain("6 AI experts");
  });
});

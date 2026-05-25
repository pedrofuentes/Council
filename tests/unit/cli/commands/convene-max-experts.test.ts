/**
 * Tests for `council convene <topic> --max-experts <n>` flag.
 *
 * RED at this commit: `--max-experts` flag does not exist yet.
 * Verifies that the flag is threaded to autoComposePanel() options.
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

/**
 * Panel JSON with exactly 2 experts (to test that maxExperts limits panel size).
 */
const smallPanelJson = JSON.stringify({
  name: "small-auto-panel",
  description: "Auto-composed panel with 2 experts",
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

/** Stub engine: first send returns the panel JSON; later sends return generic text. */
class ScriptedEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  callIndex = 0;
  /** Track system messages for verification */
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

describe("buildConveneCommand — --max-experts flag", () => {
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

  it("should accept --max-experts flag and thread it to autoComposePanel", async () => {
    const outputs: string[] = [];
    const errors: string[] = [];
    const engine = new ScriptedEngine([smallPanelJson, "round1-alpha", "round1-beta"]);

    const cmd = buildConveneCommand({
      write: (s) => {
        outputs.push(s);
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

    // Verify no error about unknown option
    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);

    // Verify the composer expert (first addExpert call) received a system prompt with correct range
    expect(engine.expertSystemMessages.length).toBeGreaterThan(0);
    const composerSystemMessage = engine.expertSystemMessages[0];
    // When maxExperts=2, minExperts should be clamped to min(3, 2) = 2, giving "panel of 2-2 AI experts"
    expect(composerSystemMessage).toContain("panel of 2-2 AI experts");
  });

  it("should use default maxExperts when flag is not provided", async () => {
    const outputs: string[] = [];
    const errors: string[] = [];
    const engine = new ScriptedEngine([
      JSON.stringify({
        name: "default-auto-panel",
        description: "Auto-composed panel with default size",
        experts: [
          {
            slug: "alpha",
            displayName: "Alpha",
            role: "Expert",
            expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
            epistemicStance: "Alpha stance",
          },
          {
            slug: "beta",
            displayName: "Beta",
            role: "Expert",
            expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
            epistemicStance: "Beta stance",
          },
          {
            slug: "gamma",
            displayName: "Gamma",
            role: "Expert",
            expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
            epistemicStance: "Gamma stance",
          },
        ],
      }),
      "r1-a",
      "r1-b",
      "r1-c",
    ]);

    const cmd = buildConveneCommand({
      write: (s) => {
        outputs.push(s);
      },
      writeError: (s) => {
        errors.push(s);
      },
      engineFactory: () => engine,
    });

    await cmd.parseAsync(["node", "council", "convene", "topic", "--yes"], {
      from: "user",
    });

    // Verify no error
    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);

    // Verify the composer was created (system message exists)
    expect(engine.expertSystemMessages.length).toBeGreaterThan(0);
    const composerSystemMessage = engine.expertSystemMessages[0];
    // The default is 3-5, so the prompt should contain "panel of 3-5 AI experts"
    expect(composerSystemMessage).toContain("panel of 3-5 AI experts");
  });

  it("should show --max-experts in help output", () => {
    const cmd = buildConveneCommand();
    const helpText = cmd.helpInformation();
    expect(helpText).toContain("--max-experts");
  });

  it("should parse --max-experts as a number", async () => {
    const outputs: string[] = [];
    const errors: string[] = [];

    const cmd = buildConveneCommand({
      write: (s) => {
        outputs.push(s);
      },
      writeError: (s) => {
        errors.push(s);
      },
      engineFactory: () => new ScriptedEngine([smallPanelJson, "round1-alpha", "round1-beta"]),
    });

    // Should parse and not throw
    await cmd.parseAsync(
      ["node", "council", "convene", "topic", "--max-experts", "3", "--yes"],
      { from: "user" },
    );

    // If parsing succeeded, no error about invalid option
    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);
    expect(errors.some((e) => e.includes("error"))).toBe(false);
  });

  it("should work without --max-experts (optional flag)", async () => {
    const outputs: string[] = [];
    const errors: string[] = [];

    const cmd = buildConveneCommand({
      write: (s) => {
        outputs.push(s);
      },
      writeError: (s) => {
        errors.push(s);
      },
      engineFactory: () => new ScriptedEngine([smallPanelJson, "round1-alpha", "round1-beta"]),
    });

    // Should work without the flag
    await cmd.parseAsync(["node", "council", "convene", "topic", "--yes"], {
      from: "user",
    });

    expect(errors.some((e) => e.includes("unknown option"))).toBe(false);
  });

  it("should reject invalid --max-experts values", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([smallPanelJson, "round1-alpha", "round1-beta"]),
    });

    // Should throw for non-positive values
    await expect(
      cmd.parseAsync(["node", "council", "convene", "topic", "--max-experts", "0", "--yes"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-experts must be a positive integer");

    await expect(
      cmd.parseAsync(["node", "council", "convene", "topic", "--max-experts", "-1", "--yes"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-experts must be a positive integer");

    // Should throw for malformed numeric input (not strict integers)
    await expect(
      cmd.parseAsync(["node", "council", "convene", "topic", "--max-experts", "1.5", "--yes"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-experts must be an integer");

    await expect(
      cmd.parseAsync(["node", "council", "convene", "topic", "--max-experts", "2abc", "--yes"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-experts must be an integer");
  });
});

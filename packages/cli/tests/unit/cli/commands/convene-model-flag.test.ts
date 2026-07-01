/**
 * Tests for `council convene <topic> --model <model>` flag.
 *
 * RED at this commit: `--model` flag does not exist yet.
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

/** Test engine that tracks the model used for each expert. */
class ModelTrackingEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  readonly expertModels: string[] = [];
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
    // Track the model used for each expert
    this.expertModels.push(spec.model);
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

describe("buildConveneCommand — --model flag", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "convene-model-flag-"));
    originalHome = process.env.COUNCIL_HOME;
    process.env.COUNCIL_HOME = testHome;

    // Write minimal config
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `defaults:
  engine: mock
  model: default-model
`,
    );
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.COUNCIL_HOME = originalHome;
    } else {
      delete process.env.COUNCIL_HOME;
    }
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("passes --model value to auto-composed experts", async () => {
    const engine = new ModelTrackingEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({
        confirm: async () => true,
      }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TDD?",
      "--model",
      "gpt-4.1",
      "--yes",
      "--max-rounds",
      "1",
    ]);

    // Verify that the model was used for the auto-composed experts
    // First expert is the composer, then the 3 panel experts, then debate-time experts
    expect(engine.expertModels.length).toBeGreaterThanOrEqual(4); // at least composer + 3 experts
    expect(engine.expertModels[0]).toBe("gpt-4.1"); // composer uses the model
    expect(engine.expertModels[1]).toBe("gpt-4.1"); // alpha expert
    expect(engine.expertModels[2]).toBe("gpt-4.1"); // beta expert
    expect(engine.expertModels[3]).toBe("gpt-4.1"); // gamma expert
  });

  it("uses config default model when --model is not provided", async () => {
    const engine = new ModelTrackingEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({
        confirm: async () => true,
      }),
    });

    await cmd.parseAsync(["node", "council-convene", "Should we adopt TDD?", "--yes", "--max-rounds", "1"]);

    // Verify that the default model from config was used
    expect(engine.expertModels.length).toBeGreaterThanOrEqual(4);
    expect(engine.expertModels[0]).toBe("default-model"); // composer
    expect(engine.expertModels[1]).toBe("default-model"); // alpha
    expect(engine.expertModels[2]).toBe("default-model"); // beta
    expect(engine.expertModels[3]).toBe("default-model"); // gamma
  });

  it("help text points users to doctor for available models", () => {
    const cmd = buildConveneCommand();
    const help = cmd.helpInformation();

    expect(help).toContain("--model <model>");
    expect(help).toContain("council doctor --models");
  });
});

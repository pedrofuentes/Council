/**
 * Tests for debate-header prompt truncation in `council convene`.
 *
 * Long topics (>200 chars) are echoed verbatim into the preamble
 * today, flooding the terminal. The header MUST display a truncated
 * form (first 200 chars + "...") while still forwarding the full
 * topic to the engine.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
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

class CapturePromptEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  /** Prompts the engine saw via send() — the engine must receive the FULL topic. */
  readonly seenPrompts: string[] = [];
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
    this.seenPrompts.push(options.prompt);
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

describe("buildConveneCommand — debate header truncation", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    setQuiet(false);
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "convene-header-trunc-"));
    originalHome = process.env.COUNCIL_HOME;
    process.env.COUNCIL_HOME = testHome;
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      `defaults:
  engine: mock
  model: default-model
`,
    );
  });

  afterEach(async () => {
    setQuiet(false);
    if (originalHome !== undefined) {
      process.env.COUNCIL_HOME = originalHome;
    } else {
      delete process.env.COUNCIL_HOME;
    }
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("truncates a long topic in the header preamble but forwards the full prompt to the engine", async () => {
    const longTopic = "Q? " + "x".repeat(500);
    const engine = new CapturePromptEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      longTopic,
      "--yes",
      "--max-rounds",
      "1",
    ]);

    // The header line must contain the truncated form, with ellipsis.
    const headerMatch = stdout.match(/Topic: (.+)\n/);
    expect(headerMatch).not.toBeNull();
    if (headerMatch === null) return;
    const displayed = headerMatch[1];
    expect(displayed.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(displayed.endsWith("...")).toBe(true);
    // The full topic must NOT appear verbatim in stdout.
    expect(stdout).not.toContain(longTopic);

    // The engine, however, must have received the FULL topic.
    expect(engine.seenPrompts.length).toBeGreaterThan(0);
    const promptForEngine = engine.seenPrompts.find((p) => p.includes(longTopic));
    expect(promptForEngine).toBeDefined();
  });

  it("displays a short topic verbatim with no ellipsis", async () => {
    const shortTopic = "Should we adopt TDD?";
    const engine = new CapturePromptEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      shortTopic,
      "--yes",
      "--max-rounds",
      "1",
    ]);

    expect(stdout).toContain(`Topic: ${shortTopic}\n`);
    const headerMatch = stdout.match(/Topic: (.+)\n/);
    expect(headerMatch).not.toBeNull();
    if (headerMatch === null) return;
    expect(headerMatch[1].endsWith("...")).toBe(false);
  });

  it("strips ANSI escape sequences and control characters from topic in the header", async () => {
    const topicWithAnsi = "\x1B[31mRed text\x1B[0m and \x1B[1mbold\x1B[0m topic";
    const cleanTopic = "Red text and bold topic";
    const engine = new CapturePromptEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      topicWithAnsi,
      "--yes",
      "--max-rounds",
      "1",
    ]);

    // The header must NOT contain the raw ANSI escape sequences.
    expect(stdout).not.toContain("\x1B[31m");
    expect(stdout).not.toContain("\x1B[0m");
    expect(stdout).not.toContain("\x1B[1m");
    // The header must contain the clean text.
    expect(stdout).toContain(`Topic: ${cleanTopic}\n`);
  });
});

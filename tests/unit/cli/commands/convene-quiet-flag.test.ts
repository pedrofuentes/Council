/**
 * Tests for `council convene <topic> --quiet|-q` flag.
 *
 * RED at this commit: the `--quiet` flag is not yet wired into the
 * Commander definition, so the action handler never calls `setQuiet(true)`
 * and informational notices (e.g. the mock-engine banner) are not
 * suppressed.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { isQuiet, setQuiet } from "../../../../src/cli/commands/writer.js";
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

class QuietProbeEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  /** Captured value of `isQuiet()` observed during engine execution. */
  quietDuringSend: boolean | undefined;
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
    if (this.quietDuringSend === undefined) {
      this.quietDuringSend = isQuiet();
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

describe("buildConveneCommand — --quiet flag", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    setQuiet(false);
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "convene-quiet-flag-"));
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

  it("help text advertises -q, --quiet", () => {
    const cmd = buildConveneCommand();
    const help = cmd.helpInformation();
    expect(help).toMatch(/-q, --quiet/);
    expect(help).toMatch(/[Ss]uppress/);
  });

  it("activates quiet mode during execution when --quiet is passed", async () => {
    const engine = new QuietProbeEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TDD?",
      "--quiet",
      "--yes",
      "--max-rounds",
      "1",
    ]);

    expect(engine.quietDuringSend).toBe(true);
  });

  it("activates quiet mode via the short -q alias", async () => {
    const engine = new QuietProbeEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TDD?",
      "-q",
      "--yes",
      "--max-rounds",
      "1",
    ]);

    expect(engine.quietDuringSend).toBe(true);
  });

  it("does not activate quiet mode when --quiet is absent", async () => {
    const engine = new QuietProbeEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TDD?",
      "--yes",
      "--max-rounds",
      "1",
    ]);

    expect(engine.quietDuringSend).toBe(false);
  });

  it("suppresses the mock-engine informational banner when --quiet is set", async () => {
    const engine = new QuietProbeEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TDD?",
      "--quiet",
      "--yes",
      "--max-rounds",
      "1",
    ]);

    expect(stderr).not.toContain("[MOCK ENGINE]");
  });

  it("emits the mock-engine informational banner when --quiet is absent", async () => {
    const engine = new QuietProbeEngine([
      validPanelJson,
      "Alpha response",
      "Beta response",
      "Gamma response",
    ]);

    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TDD?",
      "--yes",
      "--max-rounds",
      "1",
    ]);

    expect(stderr).toContain("[MOCK ENGINE]");
  });
});

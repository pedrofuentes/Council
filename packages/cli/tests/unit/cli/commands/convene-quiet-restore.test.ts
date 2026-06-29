/**
 * Regression test for #895: `convene --quiet` must restore the prior quiet
 * state when the action completes. `setQuiet()` mutates module-global state in
 * writer.ts; before the fix it was never restored, so a second in-process
 * invocation inherited `quiet=true` and silently suppressed operational
 * notices (e.g. the mock-engine banner).
 *
 * These tests deliberately do NOT call `setQuiet(false)` between sequential
 * invocations — that manual reset is the workaround we are eliminating.
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

function makeEngine(): QuietProbeEngine {
  return new QuietProbeEngine([validPanelJson, "Alpha", "Beta", "Gamma"]);
}

function runArgs(extra: readonly string[]): string[] {
  return ["node", "council-convene", "Should we adopt TDD?", "--yes", "--max-rounds", "1", ...extra];
}

describe("buildConveneCommand — quiet state restoration (#895)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    setQuiet(false);
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "convene-quiet-restore-"));
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

  it("restores quiet=false after a --quiet run completes", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => makeEngine(),
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });

    await cmd.parseAsync(runArgs(["--quiet"]));

    // No manual setQuiet(false) here — the action must have restored the
    // prior state itself. Before the fix this stays true and leaks.
    expect(isQuiet()).toBe(false);
  });

  it("does not leak quiet mode into a subsequent non-quiet invocation", async () => {
    const quiet = makeEngine();
    const cmdQuiet = buildConveneCommand({
      engineFactory: () => quiet,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });
    await cmdQuiet.parseAsync(runArgs(["--quiet"]));

    // Deliberately NO reset between runs — this is the workaround being removed.
    const loud = makeEngine();
    const cmdLoud = buildConveneCommand({
      engineFactory: () => loud,
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => ({ confirm: async () => true }),
    });
    await cmdLoud.parseAsync(runArgs([]));

    expect(quiet.quietDuringSend).toBe(true);
    expect(loud.quietDuringSend).toBe(false);
  });
});

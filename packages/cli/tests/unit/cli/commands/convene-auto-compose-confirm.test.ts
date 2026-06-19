/**
 * Tests for the auto-compose confirmation prompt — after Council
 * auto-composes a panel, the user must confirm before the debate runs,
 * unless `--yes` is passed.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConveneCommand,
  type ConfirmProvider,
} from "../../../../src/cli/commands/convene.js";
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

/** Records every confirmation request the command makes. */
function makeConfirmProvider(answer: boolean): ConfirmProvider & { calls: number } {
  const provider = {
    calls: 0,
    async confirm(): Promise<boolean> {
      provider.calls += 1;
      return answer;
    },
  };
  return provider;
}

describe("buildConveneCommand — auto-compose confirmation prompt", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-confirm-test-"));
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

  it("exposes a --yes flag that bypasses the confirmation prompt", () => {
    const cmd = buildConveneCommand({ engineFactory: () => new ScriptedEngine([]) });
    const yesOpt = cmd.options.find((o) => o.long === "--yes");
    expect(yesOpt).toBeDefined();
  });

  it("skips confirmation when --yes is passed", async () => {
    const confirm = makeConfirmProvider(false); // would abort if called
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => confirm,
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

    expect(confirm.calls).toBe(0);
  });

  it("proceeds with the debate when the user confirms (y)", async () => {
    const confirm = makeConfirmProvider(true);
    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
      confirmProvider: () => confirm,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Topic Q",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
    ]);

    expect(confirm.calls).toBe(1);
    // Debate ran — preamble + at least one expert turn were written.
    expect(stdout).toContain("Topic: Topic Q");
  });

  it("aborts with a clear message when the user declines (n)", async () => {
    const confirm = makeConfirmProvider(false);
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
      confirmProvider: () => confirm,
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync([
        "node",
        "council-convene",
        "Topic Q",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]),
    ).rejects.toThrow(/aborted/i);

    expect(confirm.calls).toBe(1);
    // The abort message should be on stderr and mention --template
    expect(stderr.toLowerCase()).toContain("aborted");
    expect(stderr).toContain("--template");
    // Debate must NOT have run — no preamble emitted.
    expect(stdout).not.toContain("Topic: Topic Q");
  });

  it("does not prompt for confirmation when --template is provided", async () => {
    const confirm = makeConfirmProvider(false);
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([]),
      write: () => undefined,
      writeError: () => undefined,
      confirmProvider: () => confirm,
    });

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

    expect(confirm.calls).toBe(0);
  });
});

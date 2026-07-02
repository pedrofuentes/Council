/**
 * Tests for the DEFAULT readline-backed auto-compose confirmation path.
 *
 * Every existing test in convene-auto-compose-confirm.test.ts injects a
 * custom `confirmProvider`, leaving the shipped readline default path
 * unreachable and untested. A regression in the real prompt wiring,
 * answer normalisation, or default-no behaviour could ship green.
 *
 * These tests exercise the `else` branch in convene.ts that calls
 * `createReadlineConfirmProvider()` directly — i.e. when no
 * `confirmProvider` dependency is injected into `buildConveneCommand`.
 * `node:readline` is mocked at the module boundary so the provider's
 * real normalisation and default-no logic runs against controlled input.
 *
 * Resolves #263.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";

// ─── readline boundary mock ───────────────────────────────────────────────────
//
// Hoisted so vi.mock() can reference it before ESM imports are resolved.
// Intercepts the dynamic `await import("node:readline")` inside confirm.ts;
// the default export alias is included for CJS↔ESM interop robustness.

const { mockCreateInterface } = vi.hoisted(() => ({
  mockCreateInterface: vi.fn(),
}));

vi.mock("node:readline", () => ({
  createInterface: mockCreateInterface,
  default: {
    createInterface: mockCreateInterface,
  },
}));

// ─── fixtures ────────────────────────────────────────────────────────────────

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
  readonly responses: readonly string[];
  callIndex = 0;

  constructor(responses: readonly string[]) {
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

/**
 * Primes `mockCreateInterface` to return an `rl` stub that immediately
 * resolves `question` with `answer`, mirroring Node's readline callback API.
 */
function primeReadlineAnswer(answer: string): void {
  const mockClose = vi.fn();
  const mockOnce = vi.fn((_event: string, _cb: () => void): void => {
    /* The "close" fallback — not fired in the normal answer path. */
  });
  const mockQuestion = vi.fn(
    (_message: string, callback: (a: string) => void): void => {
      callback(answer);
    },
  );
  mockCreateInterface.mockReturnValueOnce({
    once: mockOnce,
    question: mockQuestion,
    close: mockClose,
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("buildConveneCommand — default readline auto-compose confirm (#263)", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-rl-confirm-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;

    // Simulate an interactive TTY so isNonInteractive() returns false,
    // making the readline branch in convene.ts reachable.
    originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    mockCreateInterface.mockReset();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });

    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("proceeds with the debate when the default readline provider receives 'y'", async () => {
    primeReadlineAnswer("y");

    let stdout = "";
    // No confirmProvider → convene.ts falls through to createReadlineConfirmProvider()
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
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

    // The real readline provider was invoked — createInterface was called once.
    expect(mockCreateInterface).toHaveBeenCalledOnce();
    // Debate ran — topic header was emitted.
    expect(stdout).toContain("Topic: Topic Q");
  });

  it("proceeds when the default readline provider receives 'yes' (full-word affirmative)", async () => {
    primeReadlineAnswer("yes");

    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
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

    expect(mockCreateInterface).toHaveBeenCalledOnce();
    expect(stdout).toContain("Topic: Topic Q");
  });

  it("aborts (default-no) when the default readline provider receives a bare Enter", async () => {
    // Empty string = user pressed Enter without typing — must default to NO.
    primeReadlineAnswer("");

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

    expect(mockCreateInterface).toHaveBeenCalledOnce();
    // Abort message must appear on stderr and reference --template.
    expect(stderr.toLowerCase()).toContain("aborted");
    expect(stderr).toContain("--template");
    // Debate must NOT have run.
    expect(stdout).not.toContain("Topic: Topic Q");
  });

  it("aborts (default-no) when the default readline provider receives 'n'", async () => {
    primeReadlineAnswer("n");

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

    expect(mockCreateInterface).toHaveBeenCalledOnce();
    expect(stderr.toLowerCase()).toContain("aborted");
    // Debate must NOT have run.
    expect(stdout).not.toContain("Topic: Topic Q");
  });
});

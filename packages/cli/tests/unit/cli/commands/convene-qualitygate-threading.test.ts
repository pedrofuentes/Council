/**
 * Regression tests: `buildConveneCommand` threads `config.qualityGate` into
 * the `DebateConfig` it constructs (closes #1514, guards against future
 * accidental removal of the wiring line).
 *
 * Guard mechanism: if `qualityGate: config.qualityGate` is removed from
 * `convene.ts:~833`, `DebateConfig.qualityGate` becomes `undefined`, the
 * gate defaults to `"off"` (the Debate class treats missing config as off),
 * no `turn.quality_gate` events fire, and the first test fails because
 * `"quality gate:"` never appears in the output.
 *
 * Test strategy: configure `qualityGate.mode: "warn"` in the COUNCIL_HOME
 * `config.yaml`, run convene with `--template code-review --max-rounds 1`,
 * supply a scripted engine whose first expert response contains a forbidden
 * phrase (Layer-1 failure), then assert the plain renderer's quality-gate
 * notice (`quality gate:`) appears in stdout.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine, EngineEvent, ExpertSpec, SendOptions } from "../../../../src/engine/index.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// ---------------------------------------------------------------------------
// Scripted engine — returns a fixed sequence of responses indexed by call
// order.  Unlike MockEngine (one fixed response per expert id), this engine
// lets us supply distinct text for each send() call regardless of which
// expert is calling.
// ---------------------------------------------------------------------------

class SequencedEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly #responses: readonly string[];
  #callIndex = 0;

  constructor(responses: readonly string[]) {
    this.#responses = responses;
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
    const text = this.#responses[this.#callIndex] ?? "[fallback response]";
    this.#callIndex += 1;
    const { expertId } = options;
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

// ---------------------------------------------------------------------------
// Response fixtures
// ---------------------------------------------------------------------------

/**
 * Sycophantic response — contains "Great point" and "I agree with" (both in
 * DEFAULT_FORBIDDEN_PHRASES).  ≥12 words so Layer-3 (too_short) does NOT
 * fire independently.  Layer-1 (forbidden_phrase) fires regardless of whether
 * prior speakers exist, so this always triggers a `turn.quality_gate` event
 * in `warn` mode.
 */
const SYCO_RESPONSE =
  "Great point, I agree with this solid analysis and the approach reflects best practices for robust development here.";

/**
 * Valid response — contains "I disagree with" (a DISAGREEMENT_SIGNAL), no
 * forbidden phrases, and ≥12 words.  Passes all three quality-gate layers.
 */
const VALID_RESPONSE =
  "I disagree with the previous analysis because the failure scenario under sustained load reveals unhandled edge cases in the current implementation.";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("convene — config.qualityGate threading (regression #1514)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    setQuiet(false);
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-qg-convene-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
    // Default config: qualityGate.mode = warn (mirrors schema default, but
    // written explicitly so the test intent is self-documenting).
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      [
        "defaults:",
        "  engine: mock",
        "  model: default-model",
        "qualityGate:",
        "  mode: warn",
        "  maxRegenerations: 1",
      ].join("\n") + "\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    setQuiet(false);
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("emits a quality-gate warning in stdout when config.qualityGate.mode is 'warn' and expert responds with a forbidden phrase", async () => {
    // The code-review template has 4 experts (senior, security, perf, maintainer).
    // With --max-rounds 1, each expert speaks once → 4 send() calls.
    // "senior" is the first speaker (priorSpeakers = []) so only Layer-1 applies.
    // SYCO_RESPONSE contains "Great point" (forbidden) → gate fires → warn event.
    const engine = new SequencedEngine([
      SYCO_RESPONSE, // senior (first speaker) — Layer-1 fail → quality-gate fires
      VALID_RESPONSE, // security
      VALID_RESPONSE, // perf
      VALID_RESPONSE, // maintainer
    ]);

    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt microservices?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
    ]);

    // PlainRenderer emits: "<warn-sym> quality gate: <name> response flagged (<failures>)\n"
    // Assert on the invariant substring that appears regardless of ANSI codes or
    // Unicode/ASCII symbol choice (both symbol sets contain "quality gate:").
    expect(stdout).toContain("quality gate:");
  });

  it("suppresses quality-gate events when config.qualityGate.mode is 'off'", async () => {
    // Overwrite config to disable the gate.
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      [
        "defaults:",
        "  engine: mock",
        "  model: default-model",
        "qualityGate:",
        "  mode: off",
        "  maxRegenerations: 1",
      ].join("\n") + "\n",
      "utf-8",
    );

    const engine = new SequencedEngine([
      SYCO_RESPONSE, // same sycophantic response — but gate is off
      VALID_RESPONSE,
      VALID_RESPONSE,
      VALID_RESPONSE,
    ]);

    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => engine,
      write: (s) => {
        stdout += s;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt microservices?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
    ]);

    expect(stdout).not.toContain("quality gate:");
  });
});

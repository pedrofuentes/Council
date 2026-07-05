/**
 * RED — `council convene --model <X>` must make `<X>` the effective model for
 * every expert, overriding a panel template's declared `defaults.model`.
 *
 * Regression (T-09/F-03): `convene --model claude-haiku-4.5 --template
 * product-strategy-review` used to run every expert on the template's
 * `defaults.model` (claude-sonnet-4.5) because `--model` only entered as the
 * config-default fallback, which a template default outranks. These tests pin
 * the precedence flag > per-expert model > template default > config default
 * against the real command: the engine `addExpert(spec).model` it records AND
 * the rendered roster must both show the flagged model, and omitting the flag
 * must leave the template default in force.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import { MockEngine } from "../../src/engine/mock/mock-engine.js";
import type { ExpertSpec } from "../../src/engine/types.js";
import { captureOutput, cleanupE2EContext, createE2EContext, type E2EContext } from "./helpers.js";

const TOPIC = "Should we ship the MVP this quarter?";
const TEMPLATE = "product-strategy-review";
/** The panel's declared `defaults.model` — see panels/product-strategy-review.yaml. */
const TEMPLATE_DEFAULT_MODEL = "claude-sonnet-4.5";
/** A supported model distinct from both the template default and the config default. */
const FLAG_MODEL = "claude-haiku-4.5";

type CapturedOutput = ReturnType<typeof captureOutput>;

interface RecordingFactory {
  readonly factory: () => CouncilEngine;
  readonly recordedSpecs: ExpertSpec[];
}

/**
 * A {@link MockEngine} that records every `addExpert(spec)` it receives, so a
 * test can assert the resolved model convene actually hands the engine —
 * independent of, and in addition to, what the roster renders.
 */
function makeRecordingEngineFactory(): RecordingFactory {
  const recordedSpecs: ExpertSpec[] = [];
  class RecordingMockEngine extends MockEngine {
    override async addExpert(spec: ExpertSpec): Promise<void> {
      recordedSpecs.push(spec);
      await super.addExpert(spec);
    }
  }
  return { factory: (): CouncilEngine => new RecordingMockEngine(), recordedSpecs };
}

async function runConvene(
  args: readonly string[],
  engineFactory: () => CouncilEngine,
): Promise<CapturedOutput> {
  const output = captureOutput();
  const cmd = buildConveneCommand({
    engineFactory,
    write: output.write,
    writeError: output.writeError,
  });
  await cmd.parseAsync(["node", "council-convene", ...args]);
  return output;
}

describe("convene CLI — honors --model over template defaults", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  it("runs every expert on --model, overriding the template's defaults.model", async () => {
    const { factory, recordedSpecs } = makeRecordingEngineFactory();
    const output = await runConvene(
      [
        TOPIC,
        "--template",
        TEMPLATE,
        "--model",
        FLAG_MODEL,
        "--engine",
        "mock",
        "--max-rounds",
        "1",
        "--no-conclude",
        "--format",
        "plain",
      ],
      factory,
    );

    // The engine actually ran every expert on the flagged model, not the
    // template's declared claude-sonnet-4.5.
    expect(recordedSpecs.length).toBeGreaterThan(0);
    expect(recordedSpecs.every((spec) => spec.model === FLAG_MODEL)).toBe(true);
    expect(recordedSpecs.some((spec) => spec.model === TEMPLATE_DEFAULT_MODEL)).toBe(false);

    // ...and the rendered roster reflects it (not the template default).
    expect(output.stdout()).toContain(`(${FLAG_MODEL})`);
    expect(output.stdout()).not.toContain(`(${TEMPLATE_DEFAULT_MODEL})`);
  });

  it("uses the template's declared defaults.model when --model is omitted", async () => {
    const { factory, recordedSpecs } = makeRecordingEngineFactory();
    const output = await runConvene(
      [
        TOPIC,
        "--template",
        TEMPLATE,
        "--engine",
        "mock",
        "--max-rounds",
        "1",
        "--no-conclude",
        "--format",
        "plain",
      ],
      factory,
    );

    expect(recordedSpecs.length).toBeGreaterThan(0);
    expect(recordedSpecs.every((spec) => spec.model === TEMPLATE_DEFAULT_MODEL)).toBe(true);
    expect(output.stdout()).toContain(`(${TEMPLATE_DEFAULT_MODEL})`);
  });

  it("still rejects an unknown --model value", async () => {
    const { factory } = makeRecordingEngineFactory();
    await expect(
      runConvene(
        [
          TOPIC,
          "--template",
          TEMPLATE,
          "--model",
          "not-a-real-model",
          "--engine",
          "mock",
          "--no-conclude",
          "--format",
          "plain",
        ],
        factory,
      ),
    ).rejects.toThrow(/unknown model id/i);
  });
});

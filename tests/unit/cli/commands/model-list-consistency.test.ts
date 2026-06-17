/**
 * Cross-path model-list consistency (finding PM-03).
 *
 * Guards the single-source-of-truth invariant: every model id that
 * `council models` / `doctor --models` advertise (the canonical
 * `SUPPORTED_MODELS` registry surfaced through `formatAvailableModels`)
 * MUST pass `council convene --model` validation, and the validator must
 * advertise no id that is absent from the canonical registry — in
 * particular the bogus/stale `gpt-5.2` that was never offered by discovery
 * yet appeared in the "Valid options" list and failed at runtime.
 *
 * RED before the fix: `gpt-5.2` is still in `SUPPORTED_MODELS`, and the
 * discovery-advertised ids `claude-opus-4.8`, `gpt-5.3-codex`,
 * `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `mai-code-1-flash-internal`
 * and `auto` are rejected by `--model` as "unknown model id".
 */
import { describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { formatAvailableModels } from "../../../../src/cli/commands/models.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { SUPPORTED_MODELS } from "../../../../src/engine/models.js";

function getModelParser(): (value: string, prev: unknown) => unknown {
  const cmd = buildConveneCommand({ engineFactory: () => new MockEngine({ responses: {} }) });
  const modelOpt = cmd.options.find((o) => o.long === "--model");
  const parser = modelOpt?.parseArg as ((v: string, prev: unknown) => unknown) | undefined;
  if (parser === undefined) {
    throw new Error("convene --model option must define a validating parser");
  }
  return parser;
}

function captureRejection(parse: (v: string, prev: unknown) => unknown, value: string): string {
  try {
    parse(value, undefined);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected "${value}" to be rejected by --model validation`);
}

// Ids that `council models` advertises (live SDK discovery) but that the
// `--model` validator used to reject as "unknown model id" (PM-03).
const ADVERTISED_BUT_PREVIOUSLY_REJECTED = [
  "claude-opus-4.8",
  "gpt-5.3-codex",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "mai-code-1-flash-internal",
  "auto",
] as const;

describe("cross-path model-list consistency (PM-03)", () => {
  it("does not advertise the bogus/stale gpt-5.2 as a valid model", () => {
    expect(SUPPORTED_MODELS).not.toContain("gpt-5.2");

    const parse = getModelParser();
    const message = captureRejection(parse, "gpt-5.2");
    expect(message).toMatch(/unknown model id/i);
    expect(message).not.toContain("gpt-5.2,");
  });

  it("accepts every model id that discovery advertises", () => {
    const parse = getModelParser();
    for (const model of ADVERTISED_BUT_PREVIOUSLY_REJECTED) {
      expect(SUPPORTED_MODELS).toContain(model);
      expect(parse(model, undefined)).toBe(model);
    }
  });

  it("accepts every model in the canonical registry without modification", () => {
    const parse = getModelParser();
    for (const model of SUPPORTED_MODELS) {
      expect(parse(model, undefined)).toBe(model);
    }
  });

  it("the --model rejection lists exactly the canonical registry (no bogus ids)", () => {
    const parse = getModelParser();
    const message = captureRejection(parse, "definitely-not-a-real-model-xyz");
    expect(message).toContain(SUPPORTED_MODELS.join(", "));
    expect(message).not.toContain("gpt-5.2");
  });

  it("council models advertises every model the validator accepts (static fallback)", () => {
    const rendered = formatAvailableModels(SUPPORTED_MODELS, "static");
    for (const model of SUPPORTED_MODELS) {
      expect(rendered).toContain(model);
    }
  });
});

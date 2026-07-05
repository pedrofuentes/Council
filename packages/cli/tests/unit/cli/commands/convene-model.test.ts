/**
 * RED — `council convene --model <X>` must make `<X>` the effective model for
 * every expert, overriding a panel template's declared `defaults.model` and any
 * per-expert model. Before this fix `--model` only entered as the config-default
 * fallback, so a template's `defaults.model` (e.g. product-strategy-review's
 * `claude-sonnet-4.5`) silently outranked the flag and it was ignored.
 *
 * This unit test pins the pure `resolveConveneModel` helper that encodes the
 * precedence flag > per-expert model > template default > config default,
 * paralleling `resolveMaxRounds`. The e2e suite
 * (`tests/e2e/convene-model.test.ts`) verifies the command actually runs every
 * expert on the flagged model and renders it in the roster.
 */
import { describe, expect, it } from "vitest";

import { resolveConveneModel } from "../../../../src/cli/commands/convene.js";

describe("convene — resolveConveneModel precedence", () => {
  it("uses the explicit --model flag over expert, template, and config models", () => {
    expect(
      resolveConveneModel("flag-model", "expert-model", "template-model", "config-model"),
    ).toBe("flag-model");
  });

  it("lets the --model flag override even a per-expert declared model", () => {
    // The user explicitly asked for this run's model, so the flag wins over a
    // per-expert model — the highest-priority layer below the flag itself.
    expect(resolveConveneModel("flag-model", "expert-model", undefined, "config-model")).toBe(
      "flag-model",
    );
  });

  it("uses the per-expert model when no flag is given", () => {
    expect(resolveConveneModel(undefined, "expert-model", "template-model", "config-model")).toBe(
      "expert-model",
    );
  });

  it("falls back to the template default when neither flag nor expert model is set", () => {
    expect(resolveConveneModel(undefined, undefined, "template-model", "config-model")).toBe(
      "template-model",
    );
  });

  it("falls back to the config default when flag, expert, and template are all unset", () => {
    // A distinctive config value proves the fallback targets the config default
    // rather than any hardcoded convene constant.
    expect(resolveConveneModel(undefined, undefined, undefined, "config-model")).toBe(
      "config-model",
    );
  });

  it("treats an empty-string flag as unset and falls through to the expert model", () => {
    // An empty `--model` must not send an empty model id downstream — it falls
    // through the same way an empty YAML `model` field does.
    expect(resolveConveneModel("", "expert-model", "template-model", "config-model")).toBe(
      "expert-model",
    );
  });

  it("keeps the flag even when it must override a differing template default (the bug)", () => {
    // Pins the exact regression: a template default that WINS today must lose to
    // an explicit flag. A real flag is never silently dropped for the template.
    expect(resolveConveneModel("flag-model", undefined, "template-model", "config-model")).toBe(
      "flag-model",
    );
  });
});

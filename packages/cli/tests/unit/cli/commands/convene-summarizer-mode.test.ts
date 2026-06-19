/**
 * Tests for the convene CLI wiring of the summarizer mode (§2.6 LLM
 * upgrade). Default is "llm"; `--heuristic-summaries` flips back to the
 * heuristic.
 *
 * We exercise the flag parser directly via the public `buildContextConfig`
 * helper to avoid spinning up a full debate just to read configuration.
 */
import { describe, expect, it } from "vitest";

import {
  buildContextConfig,
  type SummarizerOptions,
} from "../../../../src/cli/commands/convene.js";

describe("buildContextConfig — summarizer mode wiring", () => {
  it("defaults to mode='llm' when --summarize-after is set without --heuristic-summaries", () => {
    const opts: SummarizerOptions = { summarizeAfter: 2 };
    const cfg = buildContextConfig(opts);
    expect(cfg?.summarizer?.mode).toBe("llm");
  });

  it("flips to mode='heuristic' when --heuristic-summaries is passed", () => {
    const opts: SummarizerOptions = { summarizeAfter: 2, heuristicSummaries: true };
    const cfg = buildContextConfig(opts);
    expect(cfg?.summarizer?.mode).toBe("heuristic");
  });

  it("does not produce a summarizer config when --summarize-after is omitted", () => {
    const opts: SummarizerOptions = {};
    const cfg = buildContextConfig(opts);
    expect(cfg?.summarizer).toBeUndefined();
  });
});

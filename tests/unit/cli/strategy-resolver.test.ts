/**
 * Direct unit tests for the CLI strategy resolver (#212).
 *
 * The resolver maps `--strategy <name>` (and the optional
 * `devils-advocate:<slug>` suffix) to a concrete `ModeratorStrategy`.
 * These tests pin its happy-path mappings and every validation/error
 * branch so future refactors of either the resolver or the CLI
 * surface can't silently regress user-facing behavior.
 */
import { describe, expect, it } from "vitest";

import {
  isStrategyName,
  resolveStrategy,
  STRATEGY_NAMES,
} from "../../../src/cli/strategy-resolver.js";
import type { ExpertSpec } from "../../../src/engine/index.js";

const cto: ExpertSpec = {
  id: "id-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};
const pm: ExpertSpec = {
  id: "id-pm",
  slug: "pm",
  displayName: "PM",
  model: "claude-sonnet-4",
  systemMessage: "You are a PM.",
};

describe("STRATEGY_NAMES", () => {
  it("exposes the public list of supported strategies", () => {
    expect(STRATEGY_NAMES).toEqual(["round-robin", "devils-advocate", "consensus-check"]);
  });
});

describe("isStrategyName", () => {
  it("accepts every published strategy name", () => {
    for (const name of STRATEGY_NAMES) expect(isStrategyName(name)).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isStrategyName("socratic")).toBe(false);
    expect(isStrategyName("")).toBe(false);
    expect(isStrategyName("ROUND-ROBIN")).toBe(false);
  });
});

describe("resolveStrategy — happy paths", () => {
  it("maps 'round-robin' to the round-robin strategy", () => {
    const s = resolveStrategy({ raw: "round-robin", experts: [cto, pm] });
    expect(s.name).toBe("round-robin");
  });

  it("maps 'consensus-check' to the consensus-check strategy", () => {
    const s = resolveStrategy({ raw: "consensus-check", experts: [cto, pm] });
    expect(s.name).toBe("consensus-check");
  });

  it("maps 'devils-advocate:<slug>' to the devils-advocate strategy with the given advocate", () => {
    const s = resolveStrategy({ raw: "devils-advocate:pm", experts: [cto, pm] });
    expect(s.name).toBe("devils-advocate");
    const assignments = s.planRound({
      experts: [cto, pm],
      round: 0,
      maxRounds: 1,
      topic: "T",
      priorTurns: [],
    });
    const pmAssignment = assignments.find((a) => a.expertSlug === "pm");
    const ctoAssignment = assignments.find((a) => a.expertSlug === "cto");
    expect(pmAssignment?.prompt).toContain("devil's advocate");
    expect(ctoAssignment?.prompt ?? "").not.toContain("devil's advocate");
  });

  it("defaults the advocate to the first expert when no slug is provided", () => {
    const s = resolveStrategy({ raw: "devils-advocate", experts: [cto, pm] });
    const assignments = s.planRound({
      experts: [cto, pm],
      round: 0,
      maxRounds: 1,
      topic: "T",
      priorTurns: [],
    });
    expect(assignments.find((a) => a.expertSlug === "cto")?.prompt).toContain(
      "devil's advocate",
    );
    expect(assignments.find((a) => a.expertSlug === "pm")?.prompt ?? "").not.toContain(
      "devil's advocate",
    );
  });
});

describe("resolveStrategy — error paths", () => {
  it("rejects unknown strategy names with a list of valid options", () => {
    expect(() => resolveStrategy({ raw: "socratic", experts: [cto] })).toThrowError(
      /Unknown --strategy value: socratic.*round-robin.*devils-advocate.*consensus-check/,
    );
  });

  it("rejects an empty value", () => {
    expect(() => resolveStrategy({ raw: "", experts: [cto] })).toThrowError(
      /Unknown --strategy value/,
    );
  });

  it("rejects 'devils-advocate:<unknown-slug>' with the available slugs", () => {
    expect(() =>
      resolveStrategy({ raw: "devils-advocate:ghost", experts: [cto, pm] }),
    ).toThrowError(/devils-advocate:ghost.*Available: cto, pm/);
  });

  it("rejects 'devils-advocate' with no experts at all", () => {
    expect(() => resolveStrategy({ raw: "devils-advocate", experts: [] })).toThrowError(
      /at least one expert/,
    );
  });
});

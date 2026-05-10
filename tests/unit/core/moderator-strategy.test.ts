/**
 * Tests for pluggable moderator strategies (ROADMAP §2.3).
 *
 * RED at this commit: ModeratorStrategy interface does not exist.
 */
import { describe, expect, it } from "vitest";

import type {
  ModeratorStrategy,
  ModeratorContext,
  TurnAssignment,
} from "../../../src/core/moderator/strategy.js";
import {
  createRoundRobinStrategy,
  createDevilsAdvocateStrategy,
  createConsensusCheckStrategy,
} from "../../../src/core/moderator/strategies.js";
import type { ExpertSpec } from "../../../src/engine/index.js";

function makeExpert(slug: string): ExpertSpec {
  return {
    id: `id-${slug}`,
    slug,
    displayName: slug.toUpperCase(),
    model: "test-model",
    systemMessage: `You are ${slug}.`,
  };
}

describe("ModeratorStrategy interface", () => {
  const experts = [makeExpert("cto"), makeExpert("pm"), makeExpert("designer")];

  describe("round-robin", () => {
    it("assigns all experts once per round in order", () => {
      const strategy = createRoundRobinStrategy();
      const ctx: ModeratorContext = {
        experts,
        round: 0,
        maxRounds: 3,
        topic: "Should we ship?",
        priorTurns: [],
      };
      const assignments = strategy.planRound(ctx);
      expect(assignments).toHaveLength(3);
      expect(assignments.map((a) => a.expertSlug)).toEqual(["cto", "pm", "designer"]);
    });

    it("generates a prompt containing the topic", () => {
      const strategy = createRoundRobinStrategy();
      const ctx: ModeratorContext = {
        experts,
        round: 0,
        maxRounds: 2,
        topic: "Should we ship?",
        priorTurns: [],
      };
      const assignments = strategy.planRound(ctx);
      expect(assignments[0]?.prompt).toContain("Should we ship?");
    });

    it("shouldContinue returns false when round >= maxRounds", () => {
      const strategy = createRoundRobinStrategy();
      const ctx: ModeratorContext = {
        experts,
        round: 3,
        maxRounds: 3,
        topic: "Topic",
        priorTurns: [],
      };
      expect(strategy.shouldContinue(ctx)).toBe(false);
    });

    it("shouldContinue returns true when more rounds remain", () => {
      const strategy = createRoundRobinStrategy();
      const ctx: ModeratorContext = {
        experts,
        round: 1,
        maxRounds: 3,
        topic: "Topic",
        priorTurns: [],
      };
      expect(strategy.shouldContinue(ctx)).toBe(true);
    });
  });

  describe("devils-advocate", () => {
    it("marks one expert as the contrarian", () => {
      const strategy = createDevilsAdvocateStrategy("pm");
      const ctx: ModeratorContext = {
        experts,
        round: 0,
        maxRounds: 2,
        topic: "Should we ship?",
        priorTurns: [],
      };
      const assignments = strategy.planRound(ctx);
      const advocateAssignment = assignments.find((a) => a.expertSlug === "pm");
      expect(advocateAssignment).toBeDefined();
      expect(advocateAssignment?.prompt.toLowerCase()).toMatch(/devil|contrarian|challenge|oppose/);
    });

    it("non-advocate experts get standard prompts", () => {
      const strategy = createDevilsAdvocateStrategy("pm");
      const ctx: ModeratorContext = {
        experts,
        round: 0,
        maxRounds: 2,
        topic: "Topic",
        priorTurns: [],
      };
      const assignments = strategy.planRound(ctx);
      const regularAssignment = assignments.find((a) => a.expertSlug === "cto");
      expect(regularAssignment).toBeDefined();
      expect(regularAssignment?.prompt.toLowerCase()).not.toMatch(/devil|contrarian/);
    });
  });

  describe("consensus-check", () => {
    it("includes prior turn content in subsequent round prompts", () => {
      const strategy = createConsensusCheckStrategy();
      const ctx: ModeratorContext = {
        experts,
        round: 1,
        maxRounds: 3,
        topic: "Should we ship?",
        priorTurns: [
          { expertSlug: "cto", displayName: "CTO", content: "Ship immediately.", round: 0 },
          { expertSlug: "pm", displayName: "PM", content: "Wait two weeks.", round: 0 },
        ],
      };
      const assignments = strategy.planRound(ctx);
      // Should reference prior positions
      const ctoPrompt = assignments.find((a) => a.expertSlug === "cto")?.prompt ?? "";
      expect(ctoPrompt.toLowerCase()).toMatch(/consensus|agree|disagree|position/);
    });

    it("planRound includes all experts", () => {
      const strategy = createConsensusCheckStrategy();
      const ctx: ModeratorContext = {
        experts,
        round: 0,
        maxRounds: 2,
        topic: "Topic",
        priorTurns: [],
      };
      const assignments = strategy.planRound(ctx);
      expect(assignments).toHaveLength(3);
    });
  });
});

describe("TurnAssignment shape", () => {
  it("has expertSlug and prompt fields", () => {
    const strategy = createRoundRobinStrategy();
    const ctx: ModeratorContext = {
      experts: [makeExpert("cto")],
      round: 0,
      maxRounds: 1,
      topic: "Topic",
      priorTurns: [],
    };
    const assignments = strategy.planRound(ctx);
    expect(assignments).toHaveLength(1);
    const a = assignments[0];
    expect(a).toHaveProperty("expertSlug", "cto");
    expect(a).toHaveProperty("prompt");
    expect(typeof a?.prompt).toBe("string");
  });
});

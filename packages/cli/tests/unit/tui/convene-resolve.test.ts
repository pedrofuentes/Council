import { describe, expect, it } from "vitest";

import { ConfigSchema, type CouncilConfig } from "../../../src/config/index.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import type { PanelDefinition } from "../../../src/core/template-loader.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { createConvenePanelResolver } from "../../../src/tui/adapters/convene-resolve.js";

const config: CouncilConfig = ConfigSchema.parse({
  defaults: {
    model: "config-model",
    engine: "mock",
    maxRounds: 2,
    maxExperts: 3,
    maxWordsPerResponse: 125,
  },
  qualityGate: { mode: "off", maxRegenerations: 0 },
});

function expert(slug: string, model = "unset"): ExpertSpec {
  return {
    id: `expert-${slug}`,
    slug,
    displayName: slug.toUpperCase(),
    model,
    systemMessage: `system:${slug}`,
  };
}

function inlineExpert(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: slug.toUpperCase(),
    role: `${slug} role`,
    expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
    epistemicStance: "evidence-led",
    kind: "generic",
  };
}

function makePanel(overrides: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    name: "launch-panel",
    experts: ["cto", "pm"],
    ...overrides,
  };
}

function createResolver(panel: PanelDefinition): ReturnType<typeof createConvenePanelResolver> {
  return createConvenePanelResolver({
    loadPanel: async (name, dataHome) => {
      expect(name).toBe("launch-panel");
      expect(dataHome).toBe("/council-data");
      return panel;
    },
    dataHome: "/council-data",
    config,
    buildSpec: async (slug, panelDefaultModel) => expert(slug, panelDefaultModel),
    resolvePanelId: async () => ({
      panelId: "panel-1",
      expertSlugToId: { cto: "row-cto", pm: "row-pm", solo: "row-solo", inline: "row-inline" },
    }),
  });
}

describe("createConvenePanelResolver", () => {
  it("uses saved structured panel defaults for config, model threading, and multi-expert phases", async () => {
    const resolvePanel = createResolver(
      makePanel({
        defaults: { mode: "structured", maxRounds: 5, model: "custom-model" },
      }),
    );

    const resolved = await resolvePanel("launch-panel");

    expect(resolved.mode).toBe("structured");
    expect(resolved.debateConfig).toMatchObject({
      mode: "structured",
      maxRounds: 5,
      maxWordsPerResponse: 125,
      qualityGate: { mode: "off", maxRegenerations: 0 },
    });
    expect(resolved.experts.map((item) => item.model)).toEqual(["custom-model", "custom-model"]);
    expect(resolved.phaseCount).toBe(4);
    expect(resolved.panelId).toBe("panel-1");
    expect(resolved.expertSlugToId).toEqual({
      cto: "row-cto",
      pm: "row-pm",
      solo: "row-solo",
      inline: "row-inline",
    });
    expect(resolved.moderator).toBe("round-robin");
  });

  it("falls back each omitted default to the TUI config and counts single-expert phases", async () => {
    const resolvePanel = createResolver(makePanel({ experts: ["solo"] }));

    const resolved = await resolvePanel("launch-panel");

    expect(resolved.mode).toBe("freeform");
    expect(resolved.debateConfig.maxRounds).toBe(2);
    expect(resolved.debateConfig.mode).toBe("freeform");
    expect(resolved.experts.map((item) => item.model)).toEqual(["config-model"]);
    expect(resolved.phaseCount).toBe(3);
  });

  it("falls back mode, max rounds, and model independently when panel defaults are partial", async () => {
    const withModeOnly = await createResolver(makePanel({ defaults: { mode: "structured" } }))(
      "launch-panel",
    );
    const withRoundsOnly = await createResolver(makePanel({ defaults: { maxRounds: 6 } }))(
      "launch-panel",
    );
    const withModelOnly = await createResolver(makePanel({ defaults: { model: "panel-model" } }))(
      "launch-panel",
    );

    expect(withModeOnly.mode).toBe("structured");
    expect(withModeOnly.debateConfig.maxRounds).toBe(2);
    expect(withModeOnly.experts.map((item) => item.model)).toEqual([
      "config-model",
      "config-model",
    ]);

    expect(withRoundsOnly.mode).toBe("freeform");
    expect(withRoundsOnly.debateConfig.maxRounds).toBe(6);
    expect(withRoundsOnly.experts.map((item) => item.model)).toEqual([
      "config-model",
      "config-model",
    ]);

    expect(withModelOnly.mode).toBe("freeform");
    expect(withModelOnly.debateConfig.maxRounds).toBe(2);
    expect(withModelOnly.experts.map((item) => item.model)).toEqual(["panel-model", "panel-model"]);
  });

  it("reads expert slugs from inline panel entries", async () => {
    const resolvePanel = createResolver(makePanel({ experts: [inlineExpert("inline")] }));

    const resolved = await resolvePanel("launch-panel");

    expect(resolved.experts.map((item) => item.slug)).toEqual(["inline"]);
    expect(resolved.phaseCount).toBe(3);
  });
});

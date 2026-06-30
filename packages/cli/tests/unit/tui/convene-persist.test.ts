import { describe, expect, it } from "vitest";

import { ConfigSchema, type CouncilConfig } from "../../../src/config/index.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import {
  parseStoredPanelDefinition,
  type PanelDefinition,
  type ResolvedPanelDefinition,
} from "../../../src/core/template-loader.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import {
  buildConveneSessionConfigJson,
  createConvenePanelResolver,
  type ConvenePanelRuntimeInput,
} from "../../../src/tui/adapters/convene-resolve.js";

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

function inlineExpert(slug: string, overrides: Partial<ExpertDefinition> = {}): ExpertDefinition {
  return {
    slug,
    displayName: slug.toUpperCase(),
    role: `${slug} role`,
    expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
    epistemicStance: "evidence-led",
    kind: "generic",
    ...overrides,
  };
}

function spec(slug: string, model: string): ExpertSpec {
  return {
    id: `expert-${slug}`,
    slug,
    displayName: slug.toUpperCase(),
    model,
    systemMessage: `system:${slug}`,
  };
}

function makePanel(overrides: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    name: "launch-panel",
    experts: ["cto", "pm"],
    ...overrides,
  };
}

describe("createConvenePanelResolver — persisted panel definition", () => {
  it("attaches a stored panel definition built from the live DB members, not the stale YAML", async () => {
    let captured: ConvenePanelRuntimeInput | undefined;
    const resolve = createConvenePanelResolver({
      loadPanel: async () =>
        makePanel({
          description: "Launch readiness review",
          defaults: { mode: "structured", maxRounds: 5, model: "panel-model" },
          experts: ["cto", "pm"],
        }),
      // YAML lists [cto, pm] but the DB membership was edited to [cto, solo].
      getMembers: async () => ["cto", "solo"],
      getExpertDefinition: async (slug) => inlineExpert(slug),
      dataHome: "/council-data",
      config,
      // The runtime spec carries a resolved/threaded model — it must NOT leak
      // into the persisted definition (that would persist a composer/runtime
      // model rather than the trusted library shape).
      buildSpec: async (slug) => spec(slug, "config-model"),
      resolvePanelId: async (input) => {
        captured = input;
        return { panelId: "panel-1", expertSlugToId: { cto: "row-cto", solo: "row-solo" } };
      },
    });

    await resolve("launch-panel");

    expect(captured).toBeDefined();
    const definition = captured?.definition;
    expect(definition).toBeDefined();
    expect(definition?.name).toBe("launch-panel");
    expect(definition?.description).toBe("Launch readiness review");
    expect(definition?.defaults).toEqual({
      mode: "structured",
      maxRounds: 5,
      model: "panel-model",
    });
    // Experts mirror the LIVE members (cto, solo), not the YAML (cto, pm).
    expect(definition?.experts.map((e) => e.slug)).toEqual(["cto", "solo"]);
    // The library ExpertDefinition has no model, so the persisted shape must
    // not carry the runtime-resolved "config-model".
    expect(definition?.experts.every((e) => e.model === undefined)).toBe(true);
  });
});

describe("buildConveneSessionConfigJson", () => {
  const definition: ResolvedPanelDefinition = {
    name: "launch-panel",
    description: "Launch readiness review",
    defaults: { mode: "freeform", maxRounds: 4 },
    experts: [inlineExpert("cto"), inlineExpert("pm")],
  };

  it("emits the CLI-parity config_json keys alongside a stored definition", () => {
    const json = buildConveneSessionConfigJson({
      panelName: "launch-panel",
      mode: "freeform",
      maxRounds: 4,
      maxWords: 250,
      engine: "mock",
      definition,
    });

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      template: "launch-panel",
      mode: "freeform",
      maxRounds: 4,
      maxWords: 250,
      engine: "mock",
    });
    expect(parsed.definition).toBeDefined();
  });

  it("round-trips through parseStoredPanelDefinition with the same name and experts", () => {
    const json = buildConveneSessionConfigJson({
      panelName: "launch-panel",
      mode: "freeform",
      maxRounds: 4,
      maxWords: 250,
      engine: "mock",
      definition,
    });

    const stored = parseStoredPanelDefinition(json);
    expect(stored.kind).toBe("ok");
    if (stored.kind !== "ok") return;
    expect(stored.definition.name).toBe("launch-panel");
    expect(stored.definition.experts.map((e) => e.slug)).toEqual(["cto", "pm"]);
  });

  it("does not persist a model the definition's experts did not carry", () => {
    const json = buildConveneSessionConfigJson({
      panelName: "launch-panel",
      mode: "freeform",
      maxRounds: 4,
      maxWords: 250,
      engine: "mock",
      definition,
    });

    const stored = parseStoredPanelDefinition(json);
    expect(stored.kind).toBe("ok");
    if (stored.kind !== "ok") return;
    expect(stored.definition.experts.every((e) => e.model === undefined)).toBe(true);
  });
});

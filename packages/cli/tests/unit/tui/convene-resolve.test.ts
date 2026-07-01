import { describe, expect, it, vi } from "vitest";

import { toSingleLineDisplay } from "../../../src/cli/strip-control-chars.js";
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

function createResolver(
  panel: PanelDefinition,
  getMembers: (panelName: string) => Promise<readonly string[]> = async () =>
    panel.experts.map((entry) => (typeof entry === "string" ? entry : entry.slug)),
): ReturnType<typeof createConvenePanelResolver> {
  return createConvenePanelResolver({
    loadPanel: async (name, dataHome) => {
      expect(name).toBe("launch-panel");
      expect(dataHome).toBe("/council-data");
      return panel;
    },
    getMembers,
    getExpertDefinition: async (slug) => inlineExpert(slug),
    dataHome: "/council-data",
    config,
    buildSpec: async (slug, panelDefaultModel) => expert(slug, panelDefaultModel),
    resolvePanelId: async () => ({
      panelId: "panel-1",
      expertSlugToId: { cto: "row-cto", pm: "row-pm", solo: "row-solo", inline: "row-inline" },
    }),
  });
}

describe("createConvenePanelResolver — membership source", () => {
  it("sources members from the live DB (getMembers), not the stale YAML experts", async () => {
    // YAML still lists [cto, pm] but the panel's members were edited in the DB to [cto, solo].
    const resolve = createResolver(makePanel({ experts: ["cto", "pm"] }), async () => [
      "cto",
      "solo",
    ]);

    const resolved = await resolve("launch-panel");

    expect(resolved.experts.map((spec) => spec.slug)).toEqual(["cto", "solo"]);
  });
});

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

describe("createConvenePanelResolver — live DB member cardinality (1-8)", () => {
  // Mirrors PanelDefinitionSchema.experts (.min(1).max(8)) in
  // core/template-loader.ts:67 — the canonical panel cardinality rule that the
  // DB-sourced membership must satisfy before convene specs are built (#1680).
  const TERMINAL_CONTROL_CHARS =
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

  function slugs(count: number): readonly string[] {
    return Array.from({ length: count }, (_unused, index) => `member-${index}`);
  }

  interface SpyResolver {
    readonly resolve: ReturnType<typeof createConvenePanelResolver>;
    readonly buildSpec: ReturnType<typeof vi.fn>;
    readonly resolvePanelId: ReturnType<typeof vi.fn>;
    readonly getExpertDefinition: ReturnType<typeof vi.fn>;
  }

  function createSpyResolver(members: readonly string[]): SpyResolver {
    const buildSpec = vi.fn(async (slug: string, model: string | undefined) => expert(slug, model));
    const resolvePanelId = vi.fn(async () => ({
      panelId: "panel-1",
      expertSlugToId: {},
    }));
    const getExpertDefinition = vi.fn(async (slug: string) => inlineExpert(slug));
    const resolve = createConvenePanelResolver({
      loadPanel: async () => makePanel(),
      getMembers: async () => members,
      getExpertDefinition,
      dataHome: "/council-data",
      config,
      buildSpec,
      resolvePanelId,
    });
    return { resolve, buildSpec, resolvePanelId, getExpertDefinition };
  }

  it("rejects a DB panel with 0 members (below the minimum) before building specs", async () => {
    const { resolve, buildSpec, resolvePanelId, getExpertDefinition } = createSpyResolver(slugs(0));

    await expect(resolve("launch-panel")).rejects.toThrow(
      /Panel "launch-panel" has 0 members, but a council debate requires between 1 and 8 experts\./,
    );
    expect(buildSpec).not.toHaveBeenCalled();
    expect(getExpertDefinition).not.toHaveBeenCalled();
    expect(resolvePanelId).not.toHaveBeenCalled();
  });

  it("rejects a DB panel with 9 members (above the maximum) before building specs", async () => {
    const { resolve, buildSpec, resolvePanelId, getExpertDefinition } = createSpyResolver(slugs(9));

    await expect(resolve("launch-panel")).rejects.toThrow(
      /Panel "launch-panel" has 9 members, but a council debate requires between 1 and 8 experts\./,
    );
    expect(buildSpec).not.toHaveBeenCalled();
    expect(getExpertDefinition).not.toHaveBeenCalled();
    expect(resolvePanelId).not.toHaveBeenCalled();
  });

  it("accepts the lower boundary of 1 member and builds specs unchanged", async () => {
    const { resolve, buildSpec, resolvePanelId } = createSpyResolver(slugs(1));

    const resolved = await resolve("launch-panel");

    expect(resolved.experts.map((spec) => spec.slug)).toEqual(["member-0"]);
    expect(resolved.phaseCount).toBe(3);
    expect(buildSpec).toHaveBeenCalledTimes(1);
    expect(resolvePanelId).toHaveBeenCalledTimes(1);
  });

  it("accepts the upper boundary of 8 members and builds specs unchanged", async () => {
    const { resolve, buildSpec, resolvePanelId } = createSpyResolver(slugs(8));

    const resolved = await resolve("launch-panel");

    expect(resolved.experts.map((spec) => spec.slug)).toEqual(slugs(8));
    expect(resolved.phaseCount).toBe(4);
    expect(buildSpec).toHaveBeenCalledTimes(8);
    expect(resolvePanelId).toHaveBeenCalledTimes(1);
  });

  it("accepts a mid-range count of 3 members and resolves normally (load-bearing inverse)", async () => {
    const { resolve, buildSpec, resolvePanelId } = createSpyResolver(slugs(3));

    const resolved = await resolve("launch-panel");

    expect(resolved.experts.map((spec) => spec.slug)).toEqual(["member-0", "member-1", "member-2"]);
    expect(buildSpec).toHaveBeenCalledTimes(3);
    expect(resolvePanelId).toHaveBeenCalledTimes(1);
  });

  it("sanitizes the untrusted panel name in the out-of-range error to a single control-free line", async () => {
    // Every terminal-injection vector from #1663 inside a DB/user-derived panel
    // name that the cardinality error echoes back to the terminal.
    const adversarialName =
      "launch\u001B[31mANSI\u009BC1\rCR\nLF\u2028LS\u2029PS\tTAB\u202Ebidi\u2066iso\u200Bzw";
    const { resolve, buildSpec } = createSpyResolver(slugs(9));

    const error = await resolve(adversarialName).then(
      () => {
        throw new Error("expected the out-of-range cardinality guard to reject");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The sanitized name is present verbatim ...
    expect(message).toContain(toSingleLineDisplay(adversarialName));
    // ... and NO raw control/bidi bytes or line breaks survive into the message.
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toMatch(TERMINAL_CONTROL_CHARS);
    // ... and the guard never proceeded to build specs.
    expect(buildSpec).not.toHaveBeenCalled();
  });
});

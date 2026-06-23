import { describe, expect, it } from "vitest";

import {
  createExpertsDataSource,
  type ExpertDefLike,
  type ExpertsRepos,
} from "../../../src/tui/adapters/experts-data.js";

const ctoExpert: ExpertDefLike = {
  slug: "cto",
  displayName: "Chief Technology Officer",
  role: "Technology strategy",
  kind: "generic",
  model: "gpt-4o",
  epistemicStance: "Evidence-weighted optimism",
  expertise: {
    weightedEvidence: ["architecture reviews"],
    referenceCases: ["scaling platform teams"],
    notExpertIn: ["tax law"],
  },
  personality: "Direct and pragmatic",
  personaDescription: "A seasoned CTO persona",
};

const financeExpert: ExpertDefLike = {
  slug: "cfo",
  displayName: "Chief Financial Officer",
  role: "Financial planning",
  kind: "persona",
  epistemicStance: "Skeptical about unsupported forecasts",
  expertise: {
    weightedEvidence: ["audited statements"],
    referenceCases: ["runway planning"],
    notExpertIn: ["frontend design"],
  },
};

const genericBareExpert: ExpertDefLike = {
  slug: "ops",
  displayName: "Operations Lead",
  role: "Operational execution",
  kind: "generic",
  epistemicStance: "Looks for bottlenecks",
  expertise: {
    weightedEvidence: [],
    referenceCases: [],
    notExpertIn: [],
  },
  model: undefined,
  personality: undefined,
  personaDescription: undefined,
};

const createRepos = (overrides: Partial<ExpertsRepos["library"]> = {}): ExpertsRepos => ({
  library: {
    list: async () => [],
    get: async () => null,
    panelsFor: async () => [],
    ...overrides,
  },
});

describe("createExpertsDataSource.loadList", () => {
  it("maps expert fields with panel counts", async () => {
    const ds = createExpertsDataSource(
      createRepos({
        list: async () => [ctoExpert, financeExpert],
        panelsFor: async (slug) => (slug === "cto" ? ["exec", "platform"] : ["finance"]),
      }),
    );

    await expect(ds.loadList()).resolves.toEqual([
      {
        slug: "cto",
        displayName: "Chief Technology Officer",
        role: "Technology strategy",
        kind: "generic",
        panelCount: 2,
      },
      {
        slug: "cfo",
        displayName: "Chief Financial Officer",
        role: "Financial planning",
        kind: "persona",
        panelCount: 1,
      },
    ]);
  });
});

describe("createExpertsDataSource.loadDetail", () => {
  it("maps a present expert with optional fields and panels", async () => {
    const ds = createExpertsDataSource(
      createRepos({
        get: async (slug) => (slug === "cto" ? ctoExpert : null),
        panelsFor: async () => ["exec", "platform"],
      }),
    );

    await expect(ds.loadDetail("cto")).resolves.toEqual({
      slug: "cto",
      displayName: "Chief Technology Officer",
      role: "Technology strategy",
      kind: "generic",
      model: "gpt-4o",
      epistemicStance: "Evidence-weighted optimism",
      expertise: {
        weightedEvidence: ["architecture reviews"],
        referenceCases: ["scaling platform teams"],
        notExpertIn: ["tax law"],
      },
      personality: "Direct and pragmatic",
      personaDescription: "A seasoned CTO persona",
      panels: ["exec", "platform"],
    });
  });

  it("returns undefined when the expert is not found", async () => {
    const ds = createExpertsDataSource(createRepos({ get: async () => null }));

    await expect(ds.loadDetail("missing")).resolves.toBeUndefined();
  });

  it("omits optional fields for a generic expert that does not define them", async () => {
    const ds = createExpertsDataSource(
      createRepos({
        get: async () => genericBareExpert,
        panelsFor: async () => [],
      }),
    );

    await expect(ds.loadDetail("ops")).resolves.toStrictEqual({
      slug: "ops",
      displayName: "Operations Lead",
      role: "Operational execution",
      kind: "generic",
      epistemicStance: "Looks for bottlenecks",
      expertise: {
        weightedEvidence: [],
        referenceCases: [],
        notExpertIn: [],
      },
      panels: [],
    });
  });
});

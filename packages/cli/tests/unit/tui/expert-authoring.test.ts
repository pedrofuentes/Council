import { describe, expect, it, vi } from "vitest";

import type { ExpertDefinition } from "../../../src/core/expert.js";
import {
  createExpertAuthoringSource,
  emptyExpertForm,
  expertToForm,
  mapPathToField,
  validateExpertForm,
  type BuildResult,
  type ExpertFormValues,
} from "../../../src/tui/adapters/expert-authoring.js";

interface FakeLibrary {
  readonly get: (slug: string) => Promise<ExpertDefinition | null>;
  readonly create: (def: ExpertDefinition) => Promise<void>;
  readonly update: (slug: string, patch: Partial<ExpertDefinition>) => Promise<void>;
  readonly delete: (
    slug: string,
    options: { readonly force: boolean },
  ) => Promise<{ readonly affectedPanels: readonly string[] }>;
  readonly panelsFor: (slug: string) => Promise<readonly string[]>;
}

const fullGenericExpert: ExpertDefinition = {
  slug: "strategy-lead",
  displayName: "Strategy Lead",
  role: "Tests market-entry assumptions",
  expertise: {
    weightedEvidence: ["customer interviews", "retention cohorts"],
    referenceCases: ["marketplace liquidity", "enterprise pilots"],
    notExpertIn: ["tax law", "kernel tuning"],
  },
  epistemicStance: "Prefers disconfirming evidence",
  kind: "generic",
  model: "gpt-5",
};

const fullPersonaExpert: ExpertDefinition = {
  slug: "maya",
  displayName: "Maya Patel",
  role: "VP Engineering persona",
  expertise: {
    weightedEvidence: ["architecture memos"],
    referenceCases: ["platform migrations"],
    notExpertIn: ["sales compensation"],
  },
  epistemicStance: "Optimistic when risks have owners",
  kind: "persona",
  model: "gpt-5-mini",
  personaDescription: "VP of Engineering I report to",
};

const validForm = (overrides: Partial<ExpertFormValues> = {}): ExpertFormValues => ({
  slug: "strategy-lead",
  displayName: "Strategy Lead",
  role: "Tests market-entry assumptions",
  weightedEvidence: "customer interviews\nretention cohorts",
  referenceCases: "marketplace liquidity\nenterprise pilots",
  notExpertIn: "tax law\nkernel tuning",
  epistemicStance: "Prefers disconfirming evidence",
  kind: "generic",
  personaDescription: "",
  model: "",
  ...overrides,
});

const expectOk = (result: BuildResult): ExpertDefinition => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected ok result, got ${JSON.stringify(result.errors)}`);
  }
  return result.definition;
};

const expectErrors = (
  result: BuildResult,
): readonly { readonly field: string; readonly error: string }[] => {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected error result, got ${JSON.stringify(result.definition)}`);
  }
  return result.errors;
};

const createFakeLibrary = (overrides: Partial<FakeLibrary> = {}): FakeLibrary => ({
  get: async () => null,
  create: async () => undefined,
  update: async () => undefined,
  delete: async () => ({ affectedPanels: [] }),
  panelsFor: async () => [],
  ...overrides,
});

describe("emptyExpertForm", () => {
  it("returns empty string values and the generic kind", () => {
    expect(emptyExpertForm()).toEqual({
      slug: "",
      displayName: "",
      role: "",
      weightedEvidence: "",
      referenceCases: "",
      notExpertIn: "",
      epistemicStance: "",
      kind: "generic",
      personaDescription: "",
      model: "",
    });
  });
});

describe("expertToForm", () => {
  it("round-trips a full generic expert through form validation", () => {
    const form = expertToForm(fullGenericExpert);

    expect(form).toEqual({
      slug: "strategy-lead",
      displayName: "Strategy Lead",
      role: "Tests market-entry assumptions",
      weightedEvidence: "customer interviews\nretention cohorts",
      referenceCases: "marketplace liquidity\nenterprise pilots",
      notExpertIn: "tax law\nkernel tuning",
      epistemicStance: "Prefers disconfirming evidence",
      kind: "generic",
      personaDescription: "",
      model: "gpt-5",
    });
    expect(expectOk(validateExpertForm(form))).toEqual(fullGenericExpert);
  });

  it("round-trips a full persona expert through form validation", () => {
    const form = expertToForm(fullPersonaExpert);

    expect(form).toEqual({
      slug: "maya",
      displayName: "Maya Patel",
      role: "VP Engineering persona",
      weightedEvidence: "architecture memos",
      referenceCases: "platform migrations",
      notExpertIn: "sales compensation",
      epistemicStance: "Optimistic when risks have owners",
      kind: "persona",
      personaDescription: "VP of Engineering I report to",
      model: "gpt-5-mini",
    });
    expect(expectOk(validateExpertForm(form))).toEqual(fullPersonaExpert);
  });

  it("uses empty strings for absent optional edit fields", () => {
    expect(
      expertToForm({
        slug: "ops",
        displayName: "Operations Lead",
        role: "Operational execution",
        expertise: {
          weightedEvidence: ["incident reviews"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "Looks for bottlenecks",
        kind: "generic",
      }),
    ).toEqual({
      slug: "ops",
      displayName: "Operations Lead",
      role: "Operational execution",
      weightedEvidence: "incident reviews",
      referenceCases: "",
      notExpertIn: "",
      epistemicStance: "Looks for bottlenecks",
      kind: "generic",
      personaDescription: "",
      model: "",
    });
  });
});

describe("validateExpertForm", () => {
  it("rejects invalid slug shapes", () => {
    expect(expectErrors(validateExpertForm(validForm({ slug: "Bad-Slug" })))).toContainEqual({
      field: "slug",
      error: "Lowercase letters, digits, hyphens (max 64)",
    });
    expect(expectErrors(validateExpertForm(validForm({ slug: "-bad" })))).toContainEqual({
      field: "slug",
      error: "Lowercase letters, digits, hyphens (max 64)",
    });
    expect(
      expectErrors(validateExpertForm(validForm({ slug: `a${"b".repeat(64)}` }))),
    ).toContainEqual({
      field: "slug",
      error: "Lowercase letters, digits, hyphens (max 64)",
    });
  });

  it("collects all cheap required-field errors before running the schema", () => {
    expect(
      expectErrors(
        validateExpertForm(
          validForm({ displayName: " ", role: "", epistemicStance: "\t", weightedEvidence: "\n," }),
        ),
      ),
    ).toEqual([
      { field: "displayName", error: "Required" },
      { field: "role", error: "Required" },
      { field: "epistemicStance", error: "Required" },
      { field: "weightedEvidence", error: "At least one is required" },
    ]);
  });

  it("maps ExpertDefinitionSchema section-marker errors back to form fields", () => {
    expect(
      expectErrors(validateExpertForm(validForm({ displayName: "Strategist [1]" }))),
    ).toContainEqual({
      field: "displayName",
      error: 'Field "displayName" must not contain section markers like [1], [2], etc.',
    });
  });

  it("includes personaDescription only for persona experts with a non-empty description", () => {
    const definition = expectOk(
      validateExpertForm(
        validForm({
          slug: "maya",
          kind: "persona",
          personaDescription: "  VP of Engineering I report to  ",
        }),
      ),
    );

    expect(definition.kind).toBe("persona");
    expect(definition.personaDescription).toBe("VP of Engineering I report to");
  });

  it("omits personaDescription for persona experts when the description is empty", () => {
    const definition = expectOk(
      validateExpertForm(validForm({ slug: "maya", kind: "persona", personaDescription: "  " })),
    );

    expect(definition.kind).toBe("persona");
    expect(definition).not.toHaveProperty("personaDescription");
  });

  it("omits personaDescription for generic experts even when form text is set", () => {
    const definition = expectOk(
      validateExpertForm(validForm({ kind: "generic", personaDescription: "Ignore me" })),
    );

    expect(definition.kind).toBe("generic");
    expect(definition).not.toHaveProperty("personaDescription");
  });

  it("includes a trimmed model when present and omits it when empty", () => {
    expect(expectOk(validateExpertForm(validForm({ model: "  gpt-5  " }))).model).toBe("gpt-5");
    expect(expectOk(validateExpertForm(validForm({ model: "  " })))).not.toHaveProperty("model");
  });

  it("assembles a fully valid generic definition and splits comma and newline lists", () => {
    expect(
      expectOk(
        validateExpertForm(
          validForm({
            slug: "risk-lead",
            displayName: "  Risk Lead  ",
            role: "  Challenges delivery risk  ",
            weightedEvidence: "a\nb, c",
            referenceCases: "d, e\n f ",
            notExpertIn: "g\n, h",
            epistemicStance: "  Skeptical until mitigations exist  ",
          }),
        ),
      ),
    ).toEqual({
      slug: "risk-lead",
      displayName: "Risk Lead",
      role: "Challenges delivery risk",
      expertise: {
        weightedEvidence: ["a", "b", "c"],
        referenceCases: ["d", "e", "f"],
        notExpertIn: ["g", "h"],
      },
      epistemicStance: "Skeptical until mitigations exist",
      kind: "generic",
    });
  });
});

describe("mapPathToField", () => {
  it("maps schema issue paths to stable form fields", () => {
    expect(mapPathToField(["displayName"])).toBe("displayName");
    expect(mapPathToField(["personality"])).toBe("epistemicStance");
    expect(mapPathToField(["expertise", "weightedEvidence"])).toBe("weightedEvidence");
    expect(mapPathToField(["unknown"])).toBe("slug");
    expect(mapPathToField([])).toBe("slug");
  });
});

describe("createExpertAuthoringSource", () => {
  it("creates a valid expert after checking for duplicate slugs", async () => {
    const create = vi.fn<(def: ExpertDefinition) => Promise<void>>(async () => undefined);
    const get = vi.fn<(slug: string) => Promise<ExpertDefinition | null>>(async () => null);
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ create, get }) });

    const result = await source.create(validForm({ weightedEvidence: "a\nb, c" }));

    const definition = expectOk(result);
    expect(get).toHaveBeenCalledWith("strategy-lead");
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(definition);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns a slug field error and skips create when the slug already exists", async () => {
    const create = vi.fn<(def: ExpertDefinition) => Promise<void>>(async () => undefined);
    const source = createExpertAuthoringSource({
      library: createFakeLibrary({ get: async () => fullGenericExpert, create }),
    });

    await expect(source.create(validForm())).resolves.toEqual({
      ok: false,
      errors: [{ field: "slug", error: "An expert with this slug already exists" }],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns validation errors and skips create for an invalid form", async () => {
    const create = vi.fn<(def: ExpertDefinition) => Promise<void>>(async () => undefined);
    const get = vi.fn<(slug: string) => Promise<ExpertDefinition | null>>(async () => null);
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ create, get }) });

    await expect(source.create(validForm({ slug: "Bad" }))).resolves.toEqual({
      ok: false,
      errors: [{ field: "slug", error: "Lowercase letters, digits, hyphens (max 64)" }],
    });
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("maps thrown create errors to sanitized slug field errors", async () => {
    const create = vi.fn<(def: ExpertDefinition) => Promise<void>>(async () => {
      throw new Error("duplicate\n\u001b[31mslug");
    });
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ create }) });

    await expect(source.create(validForm())).resolves.toEqual({
      ok: false,
      errors: [{ field: "slug", error: "duplicate slug" }],
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("forces the existing slug on update and forwards the assembled definition", async () => {
    const update = vi.fn<(slug: string, patch: Partial<ExpertDefinition>) => Promise<void>>(
      async () => undefined,
    );
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ update }) });

    const result = await source.update("existing-slug", validForm({ slug: "ignored-form-slug" }));

    const definition = expectOk(result);
    expect(definition.slug).toBe("existing-slug");
    expect(update).toHaveBeenCalledWith("existing-slug", definition);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("maps thrown update errors to sanitized slug field errors", async () => {
    const update = vi.fn<(slug: string, patch: Partial<ExpertDefinition>) => Promise<void>>(
      async () => {
        throw "not\tfound";
      },
    );
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ update }) });

    await expect(source.update("missing", validForm())).resolves.toEqual({
      ok: false,
      errors: [{ field: "slug", error: "not found" }],
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("returns validation errors and skips update for invalid forced slugs", async () => {
    const update = vi.fn<(slug: string, patch: Partial<ExpertDefinition>) => Promise<void>>(
      async () => undefined,
    );
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ update }) });

    await expect(source.update("Bad", validForm())).resolves.toEqual({
      ok: false,
      errors: [{ field: "slug", error: "Lowercase letters, digits, hyphens (max 64)" }],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("forwards remove with force enabled", async () => {
    const remove = vi.fn<
      (
        slug: string,
        options: { readonly force: boolean },
      ) => Promise<{ readonly affectedPanels: readonly string[] }>
    >(async () => ({ affectedPanels: ["exec", "platform"] }));
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ delete: remove }) });

    await expect(source.remove("strategy-lead")).resolves.toEqual({
      affectedPanels: ["exec", "platform"],
    });
    expect(remove).toHaveBeenCalledWith("strategy-lead", { force: true });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("forwards affectedPanels to panelsFor", async () => {
    const panelsFor = vi.fn<(slug: string) => Promise<readonly string[]>>(async () => ["exec"]);
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ panelsFor }) });

    await expect(source.affectedPanels("strategy-lead")).resolves.toEqual(["exec"]);
    expect(panelsFor).toHaveBeenCalledWith("strategy-lead");
    expect(panelsFor).toHaveBeenCalledTimes(1);
  });

  it("loads undefined for missing experts and form values for present experts", async () => {
    const get = vi.fn<(slug: string) => Promise<ExpertDefinition | null>>(async (slug) =>
      slug === "strategy-lead" ? fullGenericExpert : null,
    );
    const source = createExpertAuthoringSource({ library: createFakeLibrary({ get }) });

    await expect(source.loadForEdit("missing")).resolves.toBeUndefined();
    await expect(source.loadForEdit("strategy-lead")).resolves.toEqual(
      expertToForm(fullGenericExpert),
    );
    expect(get).toHaveBeenCalledWith("missing");
    expect(get).toHaveBeenCalledWith("strategy-lead");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

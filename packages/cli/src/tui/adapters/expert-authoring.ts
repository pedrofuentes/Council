import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { ExpertDefinitionSchema, type ExpertDefinition } from "../../core/expert.js";

export interface ExpertFormValues {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly weightedEvidence: string;
  readonly referenceCases: string;
  readonly notExpertIn: string;
  readonly epistemicStance: string;
  readonly kind: "generic" | "persona";
  readonly personaDescription: string;
  readonly model: string;
}

export interface ExpertFormFieldError {
  readonly field: keyof ExpertFormValues;
  readonly error: string;
}

export type BuildResult =
  | { readonly ok: true; readonly definition: ExpertDefinition }
  | { readonly ok: false; readonly errors: readonly ExpertFormFieldError[] };

export interface ExpertAuthoringSource {
  readonly loadForEdit: (slug: string) => Promise<ExpertFormValues | undefined>;
  readonly create: (values: ExpertFormValues) => Promise<BuildResult>;
  readonly update: (slug: string, values: ExpertFormValues) => Promise<BuildResult>;
  readonly remove: (slug: string) => Promise<{ readonly affectedPanels: readonly string[] }>;
  readonly affectedPanels: (slug: string) => Promise<readonly string[]>;
}

export interface ExpertAuthoringLibrary {
  get(slug: string): Promise<ExpertDefinition | null>;
  create(def: ExpertDefinition): Promise<void>;
  update(slug: string, patch: Partial<ExpertDefinition>): Promise<void>;
  delete(
    slug: string,
    options: { readonly force: boolean },
  ): Promise<{ readonly affectedPanels: readonly string[] }>;
  panelsFor(slug: string): Promise<readonly string[]>;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PATH_TO_FIELD: Readonly<Record<string, keyof ExpertFormValues>> = {
  slug: "slug",
  displayName: "displayName",
  role: "role",
  model: "model",
  "expertise.weightedEvidence": "weightedEvidence",
  "expertise.referenceCases": "referenceCases",
  "expertise.notExpertIn": "notExpertIn",
  epistemicStance: "epistemicStance",
  personality: "epistemicStance",
  kind: "kind",
  personaDescription: "personaDescription",
  docsPath: "slug",
  debateProtocol: "slug",
  outputContract: "slug",
  forbiddenMoves: "slug",
};

export function emptyExpertForm(): ExpertFormValues {
  return {
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
  };
}

function splitList(raw: string): readonly string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function expertToForm(def: ExpertDefinition): ExpertFormValues {
  return {
    slug: def.slug,
    displayName: def.displayName,
    role: def.role,
    weightedEvidence: def.expertise.weightedEvidence.join("\n"),
    referenceCases: def.expertise.referenceCases.join("\n"),
    notExpertIn: def.expertise.notExpertIn.join("\n"),
    epistemicStance: def.epistemicStance,
    kind: def.kind,
    personaDescription: def.personaDescription ?? "",
    model: def.model ?? "",
  };
}

export function mapPathToField(path: readonly unknown[]): keyof ExpertFormValues {
  const key = path.map(String).join(".");
  const mapped = PATH_TO_FIELD[key];
  if (mapped !== undefined) {
    return mapped;
  }
  return "slug";
}

export function validateExpertForm(values: ExpertFormValues): BuildResult {
  const slug = values.slug.trim();
  const displayName = values.displayName.trim();
  const role = values.role.trim();
  const epistemicStance = values.epistemicStance.trim();
  const weightedEvidence = splitList(values.weightedEvidence);
  const errors: ExpertFormFieldError[] = [];

  if (!SLUG_PATTERN.test(slug)) {
    errors.push({ field: "slug", error: "Lowercase letters, digits, hyphens (max 64)" });
  }
  if (displayName === "") {
    errors.push({ field: "displayName", error: "Required" });
  }
  if (role === "") {
    errors.push({ field: "role", error: "Required" });
  }
  if (epistemicStance === "") {
    errors.push({ field: "epistemicStance", error: "Required" });
  }
  if (weightedEvidence.length === 0) {
    errors.push({ field: "weightedEvidence", error: "At least one is required" });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const model = values.model.trim();
  const personaDescription = values.personaDescription.trim();
  const candidate = {
    slug,
    displayName,
    role,
    expertise: {
      weightedEvidence,
      referenceCases: splitList(values.referenceCases),
      notExpertIn: splitList(values.notExpertIn),
    },
    epistemicStance,
    kind: values.kind,
    ...(model !== "" ? { model } : {}),
    ...(values.kind === "persona" && personaDescription !== "" ? { personaDescription } : {}),
  };

  const parsed = ExpertDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        field: mapPathToField(issue.path),
        error: issue.message,
      })),
    };
  }

  return { ok: true, definition: parsed.data };
}

export function createExpertAuthoringSource(deps: {
  readonly library: ExpertAuthoringLibrary;
}): ExpertAuthoringSource {
  return {
    async loadForEdit(slug: string): Promise<ExpertFormValues | undefined> {
      const def = await deps.library.get(slug);
      return def === null ? undefined : expertToForm(def);
    },

    async create(values: ExpertFormValues): Promise<BuildResult> {
      const result = validateExpertForm(values);
      if (!result.ok) {
        return result;
      }
      if ((await deps.library.get(result.definition.slug)) !== null) {
        return {
          ok: false,
          errors: [{ field: "slug", error: "An expert with this slug already exists" }],
        };
      }
      try {
        await deps.library.create(result.definition);
      } catch (e) {
        return createThrownErrorResult(e);
      }
      return result;
    },

    async update(slug: string, values: ExpertFormValues): Promise<BuildResult> {
      const result = validateExpertForm({ ...values, slug });
      if (!result.ok) {
        return result;
      }
      try {
        await deps.library.update(slug, result.definition);
      } catch (e) {
        return createThrownErrorResult(e);
      }
      return result;
    },

    async remove(slug: string): Promise<{ readonly affectedPanels: readonly string[] }> {
      return deps.library.delete(slug, { force: true });
    },

    async affectedPanels(slug: string): Promise<readonly string[]> {
      return deps.library.panelsFor(slug);
    },
  };
}

function createThrownErrorResult(e: unknown): BuildResult {
  return {
    ok: false,
    errors: [
      {
        field: "slug",
        error: toSingleLineDisplay(e instanceof Error ? e.message : String(e)),
      },
    ],
  };
}

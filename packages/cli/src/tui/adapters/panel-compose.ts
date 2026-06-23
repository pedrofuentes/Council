import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { autoComposePanel, type AutoComposeOptions } from "../../core/auto-compose.js";
import { allowlistExpertDefinition, type ExpertDefinition } from "../../core/expert.js";
import type { ResolvedPanelDefinition } from "../../core/template-loader.js";
import type { CouncilEngine } from "../../engine/index.js";
import type { PanelAuthoringDataSource } from "./panel-authoring.js";

export interface ComposedExpertView {
  readonly displayName: string;
  readonly role: string;
}

export interface PanelComposePreview {
  readonly name: string;
  readonly description: string | null;
  readonly experts: readonly ComposedExpertView[];
  readonly definition: ResolvedPanelDefinition;
}

export interface PanelComposeOptions {
  readonly minExperts?: number;
  readonly maxExperts?: number;
}

export interface PanelComposeDataSource {
  compose(topic: string, options?: PanelComposeOptions): Promise<PanelComposePreview>;
  persist(definition: ResolvedPanelDefinition): Promise<{ readonly panelName: string }>;
}

export type PanelComposeFn = (
  topic: string,
  engine: CouncilEngine,
  options?: AutoComposeOptions,
) => Promise<ResolvedPanelDefinition>;

export interface PanelComposeDeps {
  readonly engineFactory: () => CouncilEngine;
  readonly defaultModel: string;
  readonly library: {
    create(def: ExpertDefinition): Promise<void>;
    get(slug: string): Promise<unknown | null>;
    delete?(slug: string, options: { readonly force: boolean }): Promise<unknown>;
  };
  readonly createPanel: PanelAuthoringDataSource["create"];
  readonly composeFn?: PanelComposeFn;
}

function composeOptions(
  options: PanelComposeOptions | undefined,
  defaultModel: string,
): AutoComposeOptions {
  return {
    ...(options?.minExperts !== undefined ? { minExperts: options.minExperts } : {}),
    ...(options?.maxExperts !== undefined ? { maxExperts: options.maxExperts } : {}),
    defaultModel,
  };
}

async function resolveCollisionFreeSlug(
  baseSlug: string,
  get: (slug: string) => Promise<unknown | null>,
): Promise<string> {
  let slug = baseSlug;
  let n = 1;
  while ((await get(slug)) !== null) {
    n += 1;
    slug = `${baseSlug}-${n}`;
  }
  return slug;
}

async function rollbackCreatedExperts(
  slugs: readonly string[],
  deleteExpert: PanelComposeDeps["library"]["delete"],
): Promise<void> {
  if (deleteExpert === undefined) return;
  for (const slug of slugs) {
    await deleteExpert(slug, { force: true }).catch(() => undefined);
  }
}

export function createPanelComposeSource(deps: PanelComposeDeps): PanelComposeDataSource {
  const composeFn = deps.composeFn ?? autoComposePanel;
  return {
    async compose(topic, options): Promise<PanelComposePreview> {
      const engine = deps.engineFactory();
      try {
        await engine.start();
        const definition = await composeFn(
          topic,
          engine,
          composeOptions(options, deps.defaultModel),
        );
        return {
          name: toSingleLineDisplay(definition.name),
          description:
            definition.description !== undefined
              ? toSingleLineDisplay(definition.description)
              : null,
          experts: definition.experts.map((expert) => ({
            displayName: toSingleLineDisplay(expert.displayName),
            role: toSingleLineDisplay(expert.role),
          })),
          definition,
        };
      } finally {
        await engine.stop().catch(() => undefined);
      }
    },

    async persist(definition): Promise<{ readonly panelName: string }> {
      const createdSlugs: string[] = [];
      try {
        const memberSlugs: string[] = [];
        for (const expert of definition.experts) {
          const slug = await resolveCollisionFreeSlug(expert.slug, deps.library.get);
          await deps.library.create(allowlistExpertDefinition(expert, slug));
          createdSlugs.push(slug);
          memberSlugs.push(slug);
        }
        await deps.createPanel({
          name: definition.name,
          description: definition.description ?? null,
          expertSlugs: memberSlugs,
          ...(definition.defaults?.mode !== undefined ? { mode: definition.defaults.mode } : {}),
          ...(definition.defaults?.maxRounds !== undefined
            ? { maxRounds: definition.defaults.maxRounds }
            : {}),
          // The composer is untrusted: never persist a model it chose (a
          // prompt-injected defaults.model would silently reroute the panel).
          // Always pin the trusted, config-derived default model.
          model: deps.defaultModel,
        });
        return { panelName: definition.name };
      } catch (err) {
        await rollbackCreatedExperts(createdSlugs, deps.library.delete);
        throw err;
      }
    },
  };
}

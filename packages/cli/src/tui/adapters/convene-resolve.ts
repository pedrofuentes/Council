import { buildPersistedPanelDefinition } from "../../cli/commands/convene.js";
import type { CouncilConfig } from "../../config/index.js";
import type { DebateConfig, DebateMode } from "../../core/debate.js";
import type { ExpertDefinition } from "../../core/expert.js";
import type { PanelDefinition, ResolvedPanelDefinition } from "../../core/template-loader.js";
import type { ExpertSpec } from "../../engine/index.js";
import type { ResolvedConvenePanel } from "./convene.js";

export interface ConvenePanelRuntimeInput {
  readonly panelName: string;
  readonly experts: readonly ExpertSpec[];
  readonly debateConfig: DebateConfig;
  readonly mode: DebateMode;
  /**
   * The resolved panel definition for the experts that ACTUALLY run (the live
   * DB members), so the session's `config_json` can persist a stored panel
   * definition for chat-reload / `council panel save` promotion — parity with
   * the classic CLI convene path (see `buildPersistedPanelDefinition`). Built
   * from the trusted library {@link ExpertDefinition}s, never from the
   * runtime/composer-resolved spec, so no untrusted model is persisted.
   */
  readonly definition: ResolvedPanelDefinition;
}

export interface ConvenePanelRuntimeIds {
  readonly panelId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
}

export interface ConvenePanelResolverDeps {
  readonly loadPanel: (name: string, dataHome: string) => Promise<PanelDefinition>;
  readonly getMembers: (panelName: string) => Promise<readonly string[]>;
  /**
   * Resolve a member slug to its full library {@link ExpertDefinition}. Used to
   * build the persisted stored panel definition from the live DB membership.
   */
  readonly getExpertDefinition: (slug: string) => Promise<ExpertDefinition>;
  readonly dataHome: string;
  readonly config: CouncilConfig;
  readonly buildSpec: (slug: string, panelDefaultModel: string | undefined) => Promise<ExpertSpec>;
  readonly resolvePanelId: (input: ConvenePanelRuntimeInput) => Promise<ConvenePanelRuntimeIds>;
}

export function createConvenePanelResolver(
  deps: ConvenePanelResolverDeps,
): (panelName: string) => Promise<ResolvedConvenePanel> {
  return async (panelName: string): Promise<ResolvedConvenePanel> => {
    // Defaults (mode/maxRounds/model) come from the panel YAML, but the CURRENT
    // membership is the DB panel_members rows — the TUI's setMembers edits the DB
    // (not the YAML), so the YAML `experts` list can be stale. Source members from
    // getMembers so a debate always runs the panel's current experts.
    const panel = await deps.loadPanel(panelName, deps.dataHome);
    const memberSlugs = await deps.getMembers(panelName);
    const mode = panel.defaults?.mode ?? "freeform";
    const maxRounds = panel.defaults?.maxRounds ?? deps.config.defaults.maxRounds;
    const panelDefaultModel = panel.defaults?.model ?? deps.config.defaults.model;
    const experts = await Promise.all(
      memberSlugs.map((slug) => deps.buildSpec(slug, panelDefaultModel)),
    );
    // Build the persistable definition from the TRUSTED library definitions of
    // the live members (not the runtime specs), so promotion via `panel save`
    // re-resolves the exact experts that ran without persisting a runtime model.
    const memberDefinitions = await Promise.all(
      memberSlugs.map((slug) => deps.getExpertDefinition(slug)),
    );
    const definition: ResolvedPanelDefinition = {
      name: panel.name,
      ...(panel.description !== undefined ? { description: panel.description } : {}),
      ...(panel.defaults !== undefined ? { defaults: panel.defaults } : {}),
      experts: memberDefinitions,
    };
    const debateConfig: DebateConfig = {
      maxRounds,
      maxWordsPerResponse: deps.config.defaults.maxWordsPerResponse,
      mode,
      qualityGate: deps.config.qualityGate,
    };
    const runtime = await deps.resolvePanelId({
      panelName,
      experts,
      debateConfig,
      mode,
      definition,
    });

    return {
      experts,
      debateConfig,
      panelId: runtime.panelId,
      expertSlugToId: runtime.expertSlugToId,
      moderator: "round-robin",
      mode,
      phaseCount: experts.length === 1 ? 3 : 4,
    };
  };
}

/**
 * Build the session `config_json` string for a TUI convene run. Mirrors the
 * classic CLI convene path (`commands/convene.ts`): the same allowlisted
 * `template`/`mode`/`maxRounds`/`maxWords`/`engine` keys, plus a persisted
 * stored panel definition (via {@link buildPersistedPanelDefinition}) so a
 * TUI-composed/run session is chat-reloadable and `council panel save`
 * promotable exactly like a CLI one.
 */
export function buildConveneSessionConfigJson(input: {
  readonly panelName: string;
  readonly mode: DebateMode;
  readonly maxRounds: number;
  readonly maxWords: number;
  readonly engine: string;
  readonly definition: ResolvedPanelDefinition;
}): string {
  return JSON.stringify({
    template: input.panelName,
    mode: input.mode,
    maxRounds: input.maxRounds,
    maxWords: input.maxWords,
    engine: input.engine,
    definition: buildPersistedPanelDefinition(input.definition),
  });
}

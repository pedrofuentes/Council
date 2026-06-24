import type { CouncilConfig } from "../../config/index.js";
import type { DebateConfig, DebateMode } from "../../core/debate.js";
import type { PanelDefinition } from "../../core/template-loader.js";
import type { ExpertSpec } from "../../engine/index.js";
import type { ResolvedConvenePanel } from "./convene.js";

export interface ConvenePanelRuntimeInput {
  readonly panelName: string;
  readonly experts: readonly ExpertSpec[];
  readonly debateConfig: DebateConfig;
  readonly mode: DebateMode;
}

export interface ConvenePanelRuntimeIds {
  readonly panelId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
}

export interface ConvenePanelResolverDeps {
  readonly loadPanel: (name: string, dataHome: string) => Promise<PanelDefinition>;
  readonly getMembers: (panelName: string) => Promise<readonly string[]>;
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
    const debateConfig: DebateConfig = {
      maxRounds,
      maxWordsPerResponse: deps.config.defaults.maxWordsPerResponse,
      mode,
      qualityGate: deps.config.qualityGate,
    };
    const runtime = await deps.resolvePanelId({ panelName, experts, debateConfig, mode });

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

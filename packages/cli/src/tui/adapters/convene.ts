import { stripControlChars, toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { Debate, type DebateConfig } from "../../core/debate.js";
import type { DebateEndReason, DebateEvent } from "../../core/types.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import type { CouncilDatabase } from "../../memory/db.js";
import { DebatePersister } from "../../memory/persister.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { TurnRepository } from "../../memory/repositories/turns.js";

export interface CostEstimate {
  readonly experts: number;
  readonly rounds: number;
  readonly estimatedPremiumRequests: number;
}

export type ConveneViewEvent =
  | { readonly kind: "panel"; readonly experts: readonly string[] }
  | { readonly kind: "round"; readonly round: number }
  | { readonly kind: "turn-start"; readonly expert: string; readonly round: number }
  | { readonly kind: "turn-delta"; readonly expert: string; readonly text: string }
  | { readonly kind: "turn-end"; readonly expert: string }
  | { readonly kind: "cost"; readonly premiumRequests: number; readonly estimatedTotal: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "end"; readonly reason: DebateEndReason };

export interface ConveneDataSource {
  estimateCost(panelName: string): Promise<CostEstimate>;
  streamDebate(
    panelName: string,
    topic: string,
    options: { readonly signal?: AbortSignal },
    onEvent: (e: ConveneViewEvent) => void,
  ): Promise<{ readonly debateId: string | undefined; readonly reason: DebateEndReason }>;
}

export interface ResolvedConvenePanel {
  readonly experts: readonly ExpertSpec[];
  readonly debateConfig: DebateConfig;
  readonly panelId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
  readonly moderator: string;
  readonly mode: "freeform" | "structured";
  readonly phaseCount: number;
}

export interface ConveneDeps {
  readonly engineFactory: () => CouncilEngine;
  readonly db: CouncilDatabase;
  readonly resolvePanel: (panelName: string) => Promise<ResolvedConvenePanel>;
}

export function createConveneSource(deps: ConveneDeps): ConveneDataSource {
  return {
    async estimateCost(panelName: string): Promise<CostEstimate> {
      const panel = await deps.resolvePanel(panelName);
      const experts = panel.experts.length;
      const rounds = panel.debateConfig.maxRounds;
      const estimatedPremiumRequests =
        panel.mode === "structured"
          ? experts * panel.phaseCount
          : experts * panel.debateConfig.maxRounds;

      return { experts, rounds, estimatedPremiumRequests };
    },

    async streamDebate(
      panelName: string,
      topic: string,
      options: { readonly signal?: AbortSignal },
      onEvent: (e: ConveneViewEvent) => void,
    ): Promise<{ readonly debateId: string | undefined; readonly reason: DebateEndReason }> {
      const panel = await deps.resolvePanel(panelName);
      const engine = deps.engineFactory();
      let reason: DebateEndReason = "failed";
      let persister: DebatePersister | undefined;

      try {
        await engine.start();
        const debate = new Debate(engine, panel.experts, panel.debateConfig, {});
        await registerExperts(engine, debate.experts);

        persister = new DebatePersister({
          debates: new DebateRepository(deps.db),
          turns: new TurnRepository(deps.db),
          panelId: panel.panelId,
          expertSlugToId: panel.expertSlugToId,
          moderator: panel.moderator,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });

        const expertLabels = labelsBySlug(debate.experts);
        const stream = persister.persist(
          debate.run(topic, options.signal ? { signal: options.signal } : {}),
          topic,
        );

        for await (const evt of stream) {
          if (evt.kind === "debate.end") {
            reason = evt.reason;
          }
          const viewEvent = toConveneViewEvent(evt, expertLabels);
          if (viewEvent !== undefined) {
            onEvent(viewEvent);
          }
        }

        return { debateId: persister.debateId, reason };
      } finally {
        // A cleanup failure must never replace the debate's primary result or
        // error (mirrors runWithEngine). Swallow engine.stop() rejections.
        await engine.stop().catch(() => undefined);
      }
    },
  };
}

async function registerExperts(
  engine: CouncilEngine,
  experts: readonly ExpertSpec[],
): Promise<void> {
  const settled = await Promise.allSettled(experts.map((expert) => engine.addExpert(expert)));
  const failures = settled
    .map((result, index) => ({ result, expert: experts[index] }))
    .filter(
      (entry): entry is { readonly result: PromiseRejectedResult; readonly expert: ExpertSpec } =>
        entry.result.status === "rejected" && entry.expert !== undefined,
    );

  if (failures.length === 0) {
    return;
  }

  const fulfilledIds = settled
    .map((result, index) => ({ result, expert: experts[index] }))
    .filter(
      (
        entry,
      ): entry is { readonly result: PromiseFulfilledResult<void>; readonly expert: ExpertSpec } =>
        entry.result.status === "fulfilled" && entry.expert !== undefined,
    )
    .map((entry) => entry.expert.id);

  await Promise.allSettled(fulfilledIds.map((id) => engine.removeExpert(id)));
  const firstReason = failures[0]?.result.reason;
  const firstMessage = firstReason instanceof Error ? firstReason.message : String(firstReason);
  throw new Error(
    `could not register all experts (${failures.length}/${experts.length} failed): ${firstMessage}`,
  );
}

function labelsBySlug(experts: readonly ExpertSpec[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    experts.map((expert) => [expert.slug, toSingleLineDisplay(expert.displayName)]),
  );
}

function expertLabel(labels: Readonly<Record<string, string>>, slug: string): string {
  return labels[slug] as string;
}

function toConveneViewEvent(
  evt: DebateEvent,
  expertLabels: Readonly<Record<string, string>>,
): ConveneViewEvent | undefined {
  switch (evt.kind) {
    case "panel.assembled":
      return {
        kind: "panel",
        experts: evt.experts.map((expert) => toSingleLineDisplay(expert.displayName)),
      };
    case "round.start":
      return { kind: "round", round: evt.round };
    case "turn.start":
      return {
        kind: "turn-start",
        expert: expertLabel(expertLabels, evt.expertSlug),
        round: evt.round,
      };
    case "turn.delta":
      return {
        kind: "turn-delta",
        expert: expertLabel(expertLabels, evt.expertSlug),
        text: stripControlChars(evt.text),
      };
    case "turn.end":
      return { kind: "turn-end", expert: expertLabel(expertLabels, evt.expertSlug) };
    case "cost.update":
      return {
        kind: "cost",
        premiumRequests: evt.premiumRequests,
        estimatedTotal: evt.estimatedTotal,
      };
    case "error":
      return { kind: "error", message: stripControlChars(evt.message) };
    case "debate.end":
      return { kind: "end", reason: evt.reason };
    case "round.end":
    case "turn.retry":
    case "turn.quality_gate":
      return undefined;
  }
}

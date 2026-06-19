/**
 * Resolves a CLI `--strategy` flag value into a concrete
 * {@link ModeratorStrategy} for the freeform debate orchestrator (#212).
 *
 * Recognised names map to factories in `core/moderator/strategies.ts`:
 *
 *   - `round-robin`       → {@link createRoundRobinStrategy}
 *   - `devils-advocate`   → {@link createDevilsAdvocateStrategy}
 *   - `consensus-check`   → {@link createConsensusCheckStrategy}
 *
 * `devils-advocate` requires an advocate slug. The CLI accepts the
 * compact form `devils-advocate:<expert-slug>`; if no slug is provided
 * the resolver falls back to the first expert in the panel.
 */
import {
  createConsensusCheckStrategy,
  createDevilsAdvocateStrategy,
  createRoundRobinStrategy,
} from "../core/moderator/strategies.js";
import type { ModeratorStrategy } from "../core/moderator/strategy.js";
import type { ExpertSpec } from "../engine/index.js";

export const STRATEGY_NAMES = [
  "round-robin",
  "devils-advocate",
  "consensus-check",
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}

export interface ResolveStrategyOptions {
  readonly raw: string;
  readonly experts: readonly ExpertSpec[];
}

export function resolveStrategy(opts: ResolveStrategyOptions): ModeratorStrategy {
  const [name, ...rest] = opts.raw.split(":");
  const advocateSlug = rest.join(":") || undefined;

  if (name === undefined || !isStrategyName(name)) {
    throw new Error(
      `Unknown --strategy value: ${opts.raw}. Expected one of: ${STRATEGY_NAMES.join(", ")} ` +
        `(devils-advocate accepts an optional advocate slug, e.g. "devils-advocate:cto").`,
    );
  }

  switch (name) {
    case "round-robin":
      return createRoundRobinStrategy();
    case "consensus-check":
      return createConsensusCheckStrategy();
    case "devils-advocate": {
      const slug = advocateSlug ?? opts.experts[0]?.slug;
      if (slug === undefined) {
        throw new Error(
          "--strategy devils-advocate requires at least one expert to designate as the advocate.",
        );
      }
      const known = opts.experts.some((e) => e.slug === slug);
      if (!known) {
        const available = opts.experts.map((e) => e.slug).join(", ");
        throw new Error(
          `--strategy devils-advocate:${slug} — expert slug not found in panel. Available: ${available}`,
        );
      }
      return createDevilsAdvocateStrategy(slug);
    }
  }
}

/**
 * Configuration schema for Council.
 *
 * Defaults are conservative — fewer experts and rounds than the upper limit
 * so a fresh user's first `council convene` doesn't burn a 30-premium-request
 * panel by accident (see DECISIONS.md ADR-001 on Copilot subscription billing).
 *
 * No API keys here: Council uses the user's GitHub Copilot auth (via
 * @github/copilot-sdk). The `model` field is a provider-agnostic identifier;
 * the engine adapter translates to the provider-native name.
 */
import { z } from "zod";

export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export const ConfigSchema = z
  .object({
    defaults: z
      .object({
        /** Provider-agnostic model id (e.g. "claude-sonnet-4-20250514"). */
        model: z.string().min(1).default(DEFAULT_MODEL),
        /** Maximum debate rounds; 1..20 inclusive. */
        maxRounds: z.number().int().min(1).max(20).default(4),
        /** Maximum experts per panel; 2..8 inclusive. */
        maxExperts: z.number().int().min(2).max(8).default(3),
        /** Soft per-expert response cap (words); 50..2000 inclusive. */
        maxWordsPerResponse: z.number().int().min(50).max(2000).default(250),
      })
      .default({
        model: DEFAULT_MODEL,
        maxRounds: 4,
        maxExperts: 3,
        maxWordsPerResponse: 250,
      }),
    telemetry: z
      .object({
        /** Opt-in only. Names of commands invoked, no content. */
        enabled: z.boolean().default(false),
      })
      .default({ enabled: false }),
  })
  .default({
    defaults: {
      model: DEFAULT_MODEL,
      maxRounds: 4,
      maxExperts: 3,
      maxWordsPerResponse: 250,
    },
    telemetry: { enabled: false },
  });

export type CouncilConfig = z.infer<typeof ConfigSchema>;

/**
 * Friendly reason mapping for retry events.
 *
 * Keyed by the stable `EngineErrorCode` threaded through `turn.retry.reasonCode`
 * (the same values emitted at runtime by debate.ts), so the friendly text
 * actually appears on real retry paths (#674).
 */
import type { EngineErrorCode } from "../../engine/index.js";

export const FRIENDLY_REASONS: Readonly<Partial<Record<EngineErrorCode, string>>> = {
  RATE_LIMITED: "rate limited, waiting...",
  NETWORK: "network issue, retrying...",
  MODEL_UNAVAILABLE: "model unavailable, retrying...",
  CONTEXT_OVERFLOW: "context too large, retrying...",
  PROVIDER_ERROR: "provider error, retrying...",
  INTERNAL: "internal error, retrying...",
};

/**
 * Map a stable engine reason code to a human-friendly message. Falls back to
 * the raw `reason` message when no code is present or no mapping exists.
 */
export function friendlyReason(reasonCode: string | undefined, reason = ""): string {
  if (reasonCode !== undefined && reasonCode in FRIENDLY_REASONS) {
    return FRIENDLY_REASONS[reasonCode as EngineErrorCode] ?? reason;
  }
  return reason;
}

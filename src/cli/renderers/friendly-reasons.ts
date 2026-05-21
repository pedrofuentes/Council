/**
 * Friendly reason mapping for retry events.
 *
 * Maps raw engine reason strings to human-readable messages
 * displayed in the PlainRenderer and ChatRenderer.
 */

export const FRIENDLY_REASONS: Readonly<Record<string, string>> = {
  rate_limit_error: "rate limited, waiting...",
  timeout: "request timed out, retrying...",
  network_error: "network issue, retrying...",
};

/**
 * Map a raw engine reason string to a human-friendly message.
 * Falls back to the raw reason if no mapping exists.
 */
export function friendlyReason(reason: string): string {
  return FRIENDLY_REASONS[reason] ?? reason;
}

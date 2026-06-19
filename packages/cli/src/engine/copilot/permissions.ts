/**
 * Permission handlers for Copilot SDK sessions.
 *
 * Per AGENTS.md (Council-specific NEVER) and DECISIONS.md ADR-004:
 *   "Every expert session MUST default to denyAll. Any tool access requires
 *    explicit per-expert opt-in via panel YAML config."
 *
 * The Copilot SDK ships a built-in `approveAll` for convenience — Council
 * MUST NOT use it. Use `denyAll` everywhere by default; use `scopedAllow`
 * with a curated whitelist when a panel template explicitly opts in.
 */

/**
 * Minimal shape Council needs from the SDK's permission-request payload.
 * Avoids importing the SDK type so this module remains usable from tests
 * that mock the SDK.
 */
export interface PermissionRequestLike {
  readonly toolName: string;
}

export interface PermissionDecision {
  readonly decision: "allow" | "deny";
}

export type PermissionHandler = (req: PermissionRequestLike) => Promise<PermissionDecision>;

/**
 * Default Council permission handler — denies every tool request.
 * Experts in Council are reasoners, not autonomous agents.
 */
export const denyAll: PermissionHandler = async () => ({ decision: "deny" });

/**
 * Build a permission handler that allows a curated set of tools and denies
 * the rest. Use ONLY when a panel YAML explicitly declares per-expert tools.
 */
export function scopedAllow(allowed: ReadonlySet<string>): PermissionHandler {
  return async (req) => (allowed.has(req.toolName) ? { decision: "allow" } : { decision: "deny" });
}

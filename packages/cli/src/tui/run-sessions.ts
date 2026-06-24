import type { ConfigLoadResult } from "../config/loader.js";

/**
 * Renders a single TUI session built from a freshly-loaded config snapshot and
 * resolves once the Ink app exits. Resolves `true` when the session asked to be
 * restarted — e.g. first-run onboarding persisted a new `defaults.model` and
 * the live session must be rebuilt from the updated config — or `false` for a
 * normal quit.
 */
export type RenderTuiSession = (session: ConfigLoadResult) => Promise<boolean>;

export interface RunTuiSessionsDeps {
  /** Reloads config and first-run state at the start of every session. */
  readonly loadConfigWithMeta: () => Promise<ConfigLoadResult>;
  /** Builds, renders, and awaits one session; resolves with the restart intent. */
  readonly renderSession: RenderTuiSession;
}

/**
 * Drives the TUI session lifecycle.
 *
 * Each iteration reloads config from disk and renders a session from that
 * snapshot. When a session resolves `true` (restart requested), the loop
 * reloads — so a model chosen during first-run onboarding, which only persists
 * to config.yaml, is re-read and applied to the rebuilt session (header, engine
 * factories, data-source default models) instead of remaining stale until the
 * next manual launch.
 */
export async function runTuiSessions(deps: RunTuiSessionsDeps): Promise<void> {
  let restart = true;
  while (restart) {
    const session = await deps.loadConfigWithMeta();
    restart = await deps.renderSession(session);
  }
}

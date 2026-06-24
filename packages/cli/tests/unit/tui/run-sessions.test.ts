import { describe, expect, it, vi } from "vitest";

import type { ConfigLoadResult } from "../../../src/config/loader.js";
import { ConfigSchema, DEFAULT_MODEL } from "../../../src/config/schema.js";
import { runTuiSessions } from "../../../src/tui/run-sessions.js";

const sessionWith = (model: string, isFirstRun: boolean): ConfigLoadResult => ({
  config: ConfigSchema.parse({ defaults: { model } }),
  isFirstRun,
});

describe("runTuiSessions", () => {
  it("renders a single session and stops when no restart is requested", async () => {
    const loadConfigWithMeta = vi.fn(async () => sessionWith(DEFAULT_MODEL, false));
    const renderSession = vi.fn(async () => false);

    await runTuiSessions({ loadConfigWithMeta, renderSession });

    expect(loadConfigWithMeta).toHaveBeenCalledTimes(1);
    expect(renderSession).toHaveBeenCalledTimes(1);
  });

  it("re-reads config and rebuilds the session with the newly persisted model after a restart", async () => {
    // First launch is a first-run with the pre-onboarding model "model-A".
    // Onboarding persists "model-B" to config.yaml and requests a restart, so
    // the SECOND load must observe the NEW model and a non-first-run state —
    // proving the live session is rebuilt from the reloaded config rather than
    // continuing to use the stale pre-onboarding model.
    const sessions: readonly ConfigLoadResult[] = [
      sessionWith("model-A", true),
      sessionWith("model-B", false),
    ];
    let call = 0;
    const loadConfigWithMeta = vi.fn(async (): Promise<ConfigLoadResult> => {
      const next = sessions[call];
      call += 1;
      if (next === undefined) {
        throw new Error("unexpected extra config load");
      }
      return next;
    });

    const rendered: { readonly model: string; readonly isFirstRun: boolean }[] = [];
    const renderSession = vi.fn(async (session: ConfigLoadResult): Promise<boolean> => {
      rendered.push({ model: session.config.defaults.model, isFirstRun: session.isFirstRun });
      // Restart once (after first-run onboarding), then quit normally.
      return rendered.length === 1;
    });

    await runTuiSessions({ loadConfigWithMeta, renderSession });

    // The active session was rebuilt from the reloaded config: the second
    // render observed model "model-B" (not the stale "model-A") and
    // isFirstRun === false (onboarding is not shown again).
    expect(rendered).toEqual([
      { model: "model-A", isFirstRun: true },
      { model: "model-B", isFirstRun: false },
    ]);
    expect(loadConfigWithMeta).toHaveBeenCalledTimes(2);
  });

  it("keeps restarting while sessions request restarts", async () => {
    const loadConfigWithMeta = vi.fn(async () => sessionWith(DEFAULT_MODEL, false));
    const restartIntents = [true, true, false];
    let index = 0;
    const renderSession = vi.fn(async (): Promise<boolean> => {
      const intent = restartIntents[index] ?? false;
      index += 1;
      return intent;
    });

    await runTuiSessions({ loadConfigWithMeta, renderSession });

    expect(renderSession).toHaveBeenCalledTimes(3);
    expect(loadConfigWithMeta).toHaveBeenCalledTimes(3);
  });
});

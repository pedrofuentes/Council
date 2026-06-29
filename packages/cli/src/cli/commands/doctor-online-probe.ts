import { CopilotEngine } from "../../engine/copilot/adapter.js";
import type { ExpertSpec } from "../../engine/index.js";

const PROBE_EXPERT: Omit<ExpertSpec, "model"> = {
  id: "doctor-model-probe",
  slug: "doctor-model-probe",
  displayName: "Doctor Model Probe",
  systemMessage: "You are a connectivity probe. Respond only if asked.",
};

/** Default upper bound for the online probe before it is abandoned. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** Minimal engine surface the probe drives — kept narrow for testability. */
interface ProbeEngine {
  start(): Promise<void>;
  addExpert(spec: ExpertSpec): Promise<void>;
  stop(): Promise<void>;
}

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly createEngine?: () => ProbeEngine;
}

const TIMEOUT = Symbol("probe-timeout");

export async function probeCopilotModel(
  model: string,
  options: ProbeOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const engine = options.createEngine ? options.createEngine() : new CopilotEngine();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async (): Promise<void> => {
      await engine.start();
      await engine.addExpert({ ...PROBE_EXPERT, model });
    })();
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const outcome = await Promise.race([work, timeout]);
    if (outcome === TIMEOUT) {
      return {
        ok: false,
        detail: `timed out after ${timeoutMs}ms creating Copilot session with ${model}`,
      };
    }
    return { ok: true, detail: `created Copilot session with ${model}` };
  } catch (err: unknown) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await engine.stop();
    } catch {
      /* best effort cleanup */
    }
  }
}

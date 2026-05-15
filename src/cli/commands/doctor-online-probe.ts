import { CopilotEngine } from "../../engine/copilot/adapter.js";
import type { ExpertSpec } from "../../engine/index.js";

const PROBE_EXPERT: Omit<ExpertSpec, "model"> = {
  id: "doctor-model-probe",
  slug: "doctor-model-probe",
  displayName: "Doctor Model Probe",
  systemMessage: "You are a connectivity probe. Respond only if asked.",
};

export async function probeCopilotModel(model: string): Promise<{ ok: boolean; detail: string }> {
  const engine = new CopilotEngine();
  try {
    await engine.start();
    await engine.addExpert({ ...PROBE_EXPERT, model });
    return { ok: true, detail: `created Copilot session with ${model}` };
  } catch (err: unknown) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await engine.stop();
    } catch {
      /* best effort cleanup */
    }
  }
}

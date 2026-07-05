/**
 * Persisted-conclusion store (T-15b / F-02).
 *
 * The auto-generated "Decision Framework" produced by `council conclude`
 * and by `convene`'s auto-conclude step is stored in the panel's existing
 * `config_json` blob, keyed by debate id — NOT in a new table (no
 * migration) and NOT in `turns` (which would pollute the transcript/FTS).
 *
 * Shape written under `config_json`:
 *
 *   { ...existingConfig, conclusions: { [debateId]: StoredConclusion } }
 *
 * Re-running `conclude` for the same debate OVERWRITES that debate's entry,
 * so there is at most one conclusion per debate. All readers tolerate
 * legacy panels (no `conclusions` key) and corrupt/partial data by
 * returning nothing rather than throwing.
 */
import type { CouncilDatabase } from "../memory/db.js";
import { PanelRepository } from "../memory/repositories/panels.js";

import {
  CONCLUSION_SCHEMA_VERSION,
  type ConcludeOutput,
  type StoredConclusion,
  StoredConclusionSchema,
} from "./conclusion-synthesis.js";

/**
 * Parse a `config_json` string into a plain object, or `undefined` when it
 * is malformed or not a JSON object. Never throws — a corrupt blob must not
 * break the conclude/convene/export flows.
 */
function parseConfig(configJson: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read and validate every conclusion stored in a panel's `config_json`.
 * Malformed entries and legacy panels yield an empty array.
 */
export function readStoredConclusions(configJson: string): readonly StoredConclusion[] {
  const config = parseConfig(configJson);
  if (config === undefined) return [];
  const raw = config["conclusions"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const out: StoredConclusion[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const result = StoredConclusionSchema.safeParse(value);
    if (!result.success) continue;
    // Normalize the zod-inferred output into the readonly ConcludeOutput
    // interface; `warnings` is only carried when actually present so it
    // stays compatible with exactOptionalPropertyTypes.
    const { warnings, ...rest } = result.data.output;
    const output: ConcludeOutput = warnings !== undefined ? { ...rest, warnings } : rest;
    out.push({ version: result.data.version, generatedAt: result.data.generatedAt, output });
  }
  return out;
}

/**
 * Choose the most relevant stored conclusion for a transcript:
 *   1. an exact match on `preferredDebateId` (the debate being exported), else
 *   2. the newest conclusion by `generatedAt`.
 * Returns `undefined` when the panel has no stored conclusion.
 */
export function selectStoredConclusion(
  configJson: string,
  preferredDebateId?: string,
): StoredConclusion | undefined {
  const entries = readStoredConclusions(configJson);
  let newest: StoredConclusion | undefined;
  for (const entry of entries) {
    if (preferredDebateId !== undefined && entry.output.debateId === preferredDebateId) {
      return entry;
    }
    if (newest === undefined || entry.generatedAt > newest.generatedAt) {
      newest = entry;
    }
  }
  return newest;
}

/**
 * Return a new `config_json` string with `output` upserted under
 * `conclusions[output.debateId]`, preserving all other config keys. A
 * corrupt/absent base config is replaced with a fresh object rather than
 * throwing (the prior value was already unusable).
 */
export function upsertConclusionInConfig(
  configJson: string,
  output: ConcludeOutput,
  generatedAt: string,
): string {
  const base = parseConfig(configJson) ?? {};
  const existing = base["conclusions"];
  const conclusions: Record<string, StoredConclusion> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, StoredConclusion>) }
      : {};
  conclusions[output.debateId] = {
    version: CONCLUSION_SCHEMA_VERSION,
    generatedAt,
    output,
  };
  return JSON.stringify({ ...base, conclusions });
}

/**
 * Persist a synthesized conclusion into a panel's `config_json`, keyed by
 * `output.debateId` (overwriting any prior conclusion for that debate). A
 * no-op if the panel no longer exists.
 */
export async function persistConclusion(
  db: CouncilDatabase,
  panelId: string,
  output: ConcludeOutput,
): Promise<void> {
  const panelRepo = new PanelRepository(db);
  const panel = await panelRepo.findById(panelId);
  if (panel === undefined) return;
  const updated = upsertConclusionInConfig(panel.configJson, output, new Date().toISOString());
  await panelRepo.update(panelId, { configJson: updated });
}

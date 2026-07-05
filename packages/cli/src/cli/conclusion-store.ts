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
import { sql } from "kysely";

import type { CouncilDatabase } from "../memory/db.js";

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
    // Issue #2412 Item 1: Reject conclusions with version > CONCLUSION_SCHEMA_VERSION
    // (future/incompatible versions that this CLI version cannot safely interpret).
    if (result.data.version > CONCLUSION_SCHEMA_VERSION) {
      continue;
    }
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
 *
 * Issue #2412 Item 2: Uses SQLite's json_set() to perform the read-modify-write
 * in a single atomic UPDATE, eliminating the read-then-update race that could
 * clobber concurrent config_json field writes.
 */
export async function persistConclusion(
  db: CouncilDatabase,
  panelId: string,
  output: ConcludeOutput,
): Promise<void> {
  const stored: StoredConclusion = {
    version: CONCLUSION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    output,
  };
  const now = new Date().toISOString();

  // Atomic read-modify-write using SQLite's json_set() to merge the new
  // conclusion into config_json.conclusions[debateId]. This prevents the race
  // where two concurrent persist calls read stale config_json, merge their
  // respective conclusions into separate copies, then last-writer-wins clobbers
  // the first's conclusion. json_set() operates entirely within the UPDATE
  // statement, so the read+merge+write happens atomically.
  //
  // Strategy: use two nested json_set() calls:
  // 1. Outer: ensure $.conclusions exists (initialize to '{}' if missing).
  // 2. Inner: write the new conclusion to $.conclusions[debateId].
  const conclusionsPath = "$.conclusions";
  const debateKey = `$.conclusions."${output.debateId}"`;
  const storedJson = JSON.stringify(stored);

  await db
    .updateTable("panels")
    .set({
      config_json: sql<string>`json_set(
        json_set(
          config_json,
          ${conclusionsPath},
          coalesce(json_extract(config_json, ${conclusionsPath}), json('{}'))
        ),
        ${debateKey},
        json(${storedJson})
      )`,
      updated_at: now,
    })
    .where("id", "=", panelId)
    .execute();
}

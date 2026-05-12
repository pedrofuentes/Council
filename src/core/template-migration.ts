/**
 * Template migration — extract experts from built-in panel templates into
 * standalone YAML files in `<dataHome>/experts/`, rewrite the panels in
 * `<dataHome>/panels/` to reference experts by slug, and register the
 * resulting panel/membership rows in the SQLite library tables.
 *
 * Design goals:
 *   - **Idempotent**: running twice never duplicates files or rows.
 *   - **Non-destructive**: existing user files (experts or panels) are
 *     never overwritten; collisions cause the new entry to be suffixed
 *     with the source panel name.
 *   - **Deduplication**: when two panels define the same slug with the
 *     SAME definition, only one expert file is written and both panels
 *     reference it. Different definitions for the same slug get
 *     disambiguated suffixes (e.g. `sre-incident-postmortem`).
 *
 * This module is invoked at most once on a user's machine — typically the
 * first time `council` is run after `~/Council/` is created. Subsequent
 * invocations are cheap (they short-circuit via {@link isMigrationNeeded}).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as yaml from "yaml";

import type { ExpertLibrary } from "./expert-library.js";
import { ExpertDefinitionSchema, type ExpertDefinition } from "./expert.js";
import { listTemplates, loadTemplate, type ResolvedPanelDefinition } from "./template-loader.js";
import type { CouncilDatabase } from "../memory/db.js";

export interface MigrationResult {
  readonly panelsMigrated: number;
  readonly expertsExtracted: number;
  readonly duplicatesUnified: number;
  readonly skipped: number;
}

/**
 * Check whether a built-in template migration should run for this data
 * directory. Returns `true` when `<dataHome>/experts/` is missing or
 * contains no YAML files — i.e. the directory is "fresh" and nothing has
 * been migrated yet. Once any expert exists, migration is treated as
 * already done; future runs short-circuit.
 */
export async function isMigrationNeeded(dataHome: string): Promise<boolean> {
  const expertsDir = path.join(dataHome, "experts");
  let entries: string[];
  try {
    entries = await fs.readdir(expertsDir);
  } catch (err: unknown) {
    if (isENOENT(err)) return true;
    throw err;
  }
  return !entries.some((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
}

/**
 * Migrate the built-in panel templates that ship with Council into the
 * user's data directory. Safe to call repeatedly — already-migrated items
 * are skipped.
 */
export async function migrateBuiltInTemplates(
  dataHome: string,
  library: ExpertLibrary,
  options: { quiet?: boolean } = {},
): Promise<MigrationResult> {
  const expertsDir = path.join(dataHome, "experts");
  const panelsDir = path.join(dataHome, "panels");
  await fs.mkdir(expertsDir, { recursive: true });
  await fs.mkdir(panelsDir, { recursive: true });

  const db = getDb(library);

  const templateNames = [...(await listTemplates())].sort();

  // Tracks slugs we have already claimed in this run (either created or
  // reused from the existing library). Maps final-slug → canonical def.
  const claimed = new Map<string, ExpertDefinition>();

  let expertsExtracted = 0;
  let duplicatesUnified = 0;
  let skipped = 0;
  let panelsMigrated = 0;

  for (const name of templateNames) {
    const template = await loadTemplate(name);

    // Decide a final slug for each expert in this panel.
    const slugForEntry: string[] = [];
    for (const expert of template.experts) {
      const decision = await pickSlug(expert, name, claimed, library);
      slugForEntry.push(decision.slug);
      switch (decision.action) {
        case "create": {
          const toCreate: ExpertDefinition = ExpertDefinitionSchema.parse({
            ...expert,
            slug: decision.slug,
          });
          await library.create(toCreate);
          claimed.set(decision.slug, toCreate);
          expertsExtracted++;
          break;
        }
        case "reuse-session":
          duplicatesUnified++;
          break;
        case "reuse-library":
          skipped++;
          break;
      }
    }

    // Write the panel YAML (skip if the user already has one with this name).
    const panelFile = path.join(panelsDir, `${name}.yaml`);
    if (await fileExists(panelFile)) {
      skipped++;
      continue;
    }
    const panelYaml = renderPanelYaml(template, slugForEntry);
    await fs.writeFile(panelFile, panelYaml, "utf-8");
    await registerPanel(db, name, template, slugForEntry, panelFile, panelYaml);
    panelsMigrated++;
  }

  if (!options.quiet) {
    console.log(
      `ℹ Migrated ${panelsMigrated} panels and ${expertsExtracted} experts to the new library format.`,
    );
  }

  return { panelsMigrated, expertsExtracted, duplicatesUnified, skipped };
}

interface SlugDecision {
  readonly slug: string;
  readonly action: "create" | "reuse-session" | "reuse-library";
}

/**
 * Choose the final slug for an inline expert definition, applying the
 * dedup + disambiguation rules. The returned `action` tells the caller
 * what (if anything) to write.
 */
async function pickSlug(
  expert: ExpertDefinition,
  panelName: string,
  claimed: Map<string, ExpertDefinition>,
  library: ExpertLibrary,
): Promise<SlugDecision> {
  const base = expert.slug;

  const sessionDef = claimed.get(base);
  if (sessionDef) {
    if (defsEqual(sessionDef, expert)) {
      return { slug: base, action: "reuse-session" };
    }
    return resolveSuffixed(base, panelName, expert, claimed, library);
  }

  // When the library already contains an expert at this slug, defer to it
  // unconditionally — the user's existing definition wins and the panel
  // simply references their slug. (Per migration spec §2.a.)
  const libraryDef = await library.get(base);
  if (libraryDef) {
    claimed.set(base, libraryDef);
    return { slug: base, action: "reuse-library" };
  }

  return { slug: base, action: "create" };
}

async function resolveSuffixed(
  base: string,
  panelName: string,
  expert: ExpertDefinition,
  claimed: Map<string, ExpertDefinition>,
  library: ExpertLibrary,
): Promise<SlugDecision> {
  const primary = `${base}-${panelName}`;
  const candidates = [primary];
  for (let i = 2; i < 100; i++) candidates.push(`${primary}-${i}`);

  for (const candidate of candidates) {
    const sessionDef = claimed.get(candidate);
    if (sessionDef) {
      if (defsEqual(sessionDef, expert)) {
        return { slug: candidate, action: "reuse-session" };
      }
      continue;
    }
    const libraryDef = await library.get(candidate);
    if (libraryDef) {
      if (defsEqual(libraryDef, expert)) {
        claimed.set(candidate, libraryDef);
        return { slug: candidate, action: "reuse-library" };
      }
      continue;
    }
    return { slug: candidate, action: "create" };
  }
  throw new Error(
    `Unable to find a free slug for expert "${expert.slug}" in panel "${panelName}" after 100 attempts`,
  );
}

function defsEqual(a: ExpertDefinition, b: ExpertDefinition): boolean {
  // Compare ignoring slug — two defs that differ only in the disambiguating
  // slug suffix represent the same expert content.
  const stripSlug = (d: ExpertDefinition): Omit<ExpertDefinition, "slug"> => {
    const { slug: _slug, ...rest } = d;
    return rest;
  };
  return canonical(stripSlug(a)) === canonical(stripSlug(b));
}

function canonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      sorted[key] = canonicalize(v);
    }
    return sorted;
  }
  return value;
}

function renderPanelYaml(template: ResolvedPanelDefinition, slugs: readonly string[]): string {
  const out: Record<string, unknown> = { name: template.name };
  if (template.description !== undefined) out["description"] = template.description;
  if (template.defaults !== undefined) out["defaults"] = template.defaults;
  out["experts"] = [...slugs];
  return yaml.stringify(out);
}

async function registerPanel(
  db: CouncilDatabase,
  panelName: string,
  template: ResolvedPanelDefinition,
  slugs: readonly string[],
  yamlPath: string,
  yamlContent: string,
): Promise<void> {
  const now = new Date().toISOString();
  const checksum = createHash("sha256").update(yamlContent).digest("hex");

  const existingPanel = await db
    .selectFrom("panel_library")
    .selectAll()
    .where("name", "=", panelName)
    .executeTakeFirst();
  if (!existingPanel) {
    await db
      .insertInto("panel_library")
      .values({
        name: panelName,
        description: template.description ?? null,
        yaml_path: yamlPath,
        yaml_checksum: checksum,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i] as string;
    const existingMember = await db
      .selectFrom("panel_members")
      .selectAll()
      .where("panel_name", "=", panelName)
      .where("expert_slug", "=", slug)
      .executeTakeFirst();
    if (existingMember) continue;
    await db
      .insertInto("panel_members")
      .values({
        panel_name: panelName,
        expert_slug: slug,
        position: i,
        created_at: now,
      })
      .execute();
  }
}

/**
 * Reach into FileExpertLibrary to get its underlying database handle for
 * registering panel rows. We do not want to expose `db` on the public
 * `ExpertLibrary` interface, so we accept the pragmatic coupling here:
 * the migration is a Council-internal one-shot operation that needs both
 * the expert API and the panel-library tables that share the same DB.
 */
function getDb(library: ExpertLibrary): CouncilDatabase {
  const db = (library as unknown as { db?: CouncilDatabase }).db;
  if (!db) {
    throw new Error(
      "migrateBuiltInTemplates requires an ExpertLibrary backed by a CouncilDatabase (FileExpertLibrary).",
    );
  }
  return db;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

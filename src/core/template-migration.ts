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
import { ExpertLibraryRepository } from "../memory/repositories/expert-library-repo.js";

export interface MigrationResult {
  readonly panelsMigrated: number;
  readonly expertsExtracted: number;
  readonly duplicatesUnified: number;
  readonly skipped: number;
}

/**
 * Loader injected by tests. Defaults to the built-in {@link loadTemplate}.
 * Returns a fully-inlined panel definition (no slug references).
 */
export type PanelLoader = (name: string) => Promise<ResolvedPanelDefinition>;

export interface MigrationOptions {
  readonly quiet?: boolean;
  /** Override the list of template names to migrate (default: all built-ins). */
  readonly panelNames?: readonly string[];
  /** Override the template loader (default: {@link loadTemplate}). */
  readonly loadPanel?: PanelLoader;
}

/**
 * Check whether a built-in template migration should run.
 *
 * Returns `true` when:
 *   - `<dataHome>/experts/` is missing or contains no YAML files (fresh
 *     install), OR
 *   - `db` is provided and the `expert_library` table is empty (DB was
 *     recreated/reset but files may still exist — re-register).
 *
 * Once both filesystem and DB show migrated state, returns `false`.
 */
export async function isMigrationNeeded(
  dataHome: string,
  db?: CouncilDatabase,
): Promise<boolean> {
  const expertsDir = path.join(dataHome, "experts");
  let entries: string[];
  try {
    entries = await fs.readdir(expertsDir);
  } catch (err: unknown) {
    if (isENOENT(err)) return true;
    throw err;
  }
  const fsEmpty = !entries.some((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (fsEmpty) return true;

  if (db) {
    const anyRow = await db
      .selectFrom("expert_library")
      .select("slug")
      .limit(1)
      .executeTakeFirst();
    if (!anyRow) return true;
  }
  return false;
}

/**
 * Migrate the built-in panel templates that ship with Council into the
 * user's data directory. Safe to call repeatedly — already-migrated items
 * are skipped.
 *
 * Takes `db` explicitly (alongside `library`) because the migration needs
 * to write to `panel_library` / `panel_members`, which are *not* exposed
 * on the abstract {@link ExpertLibrary} interface. Passing the handle
 * makes the dependency on the underlying SQLite store explicit and lets
 * tests substitute an in-memory database without reaching into the
 * library implementation.
 */
export async function migrateBuiltInTemplates(
  dataHome: string,
  library: ExpertLibrary,
  db: CouncilDatabase,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const expertsDir = path.join(dataHome, "experts");
  const panelsDir = path.join(dataHome, "panels");
  await fs.mkdir(expertsDir, { recursive: true });
  await fs.mkdir(panelsDir, { recursive: true });

  const loader: PanelLoader = options.loadPanel ?? loadTemplate;
  const templateNames = options.panelNames
    ? [...options.panelNames]
    : [...(await listTemplates())].sort();

  // Tracks slugs we have already claimed in this run (either created or
  // reused from the existing library). Maps final-slug → canonical def.
  const claimed = new Map<string, ExpertDefinition>();

  let expertsExtracted = 0;
  let duplicatesUnified = 0;
  let skipped = 0;
  let panelsMigrated = 0;

  const expertRepo = new ExpertLibraryRepository(db);

  for (const name of templateNames) {
    const template = await loader(name);

    // Decide a final slug for each expert in this panel.
    const slugForEntry: string[] = [];
    for (const expert of template.experts) {
      const decision = await pickSlug(expert, name, claimed, library);
      slugForEntry.push(decision.slug);
      switch (decision.action) {
        case "create": {
          const yamlPath = path.join(expertsDir, `${decision.slug}.yaml`);
          const toCreate: ExpertDefinition = ExpertDefinitionSchema.parse({
            ...expert,
            slug: decision.slug,
          });
          if (await fileExists(yamlPath)) {
            // File present but no DB row — register the DB row from the
            // on-disk YAML content so re-running migration after a DB
            // reset re-syncs library state from preserved (possibly
            // user-edited) files instead of clobbering metadata with the
            // bundled template.
            const content = await fs.readFile(yamlPath, "utf-8");
            const onDisk = ExpertDefinitionSchema.parse(
              yaml.parse(content) as unknown,
            );
            await expertRepo.create({
              slug: onDisk.slug,
              kind: onDisk.kind,
              displayName: onDisk.displayName,
              yamlPath,
              yamlChecksum: sha256(content),
            });
          } else {
            await library.create(toCreate);
          }
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

    const panelFile = path.join(panelsDir, `${name}.yaml`);
    const panelFileExists = await fileExists(panelFile);

    if (panelFileExists) {
      // DB-reset recovery: preserve the user's on-disk panel YAML and
      // derive DB rows from it instead of the bundled template, so
      // edits to description / member ordering survive a re-register.
      const onDiskContent = await fs.readFile(panelFile, "utf-8");
      const onDisk = parseOnDiskPanel(onDiskContent);
      await registerPanelFromDisk(
        db,
        name,
        onDisk.description,
        onDisk.slugs,
        panelFile,
        onDiskContent,
      );
      skipped++;
      continue;
    }

    // Fresh-write path: render and persist the bundled template's panel
    // YAML, then register DB rows from the template. Order is
    // registerPanel → writeFile so a crash between the two is
    // recoverable on retry (registerPanel is idempotent).
    const panelYaml = renderPanelYaml(template, slugForEntry);
    await registerPanelFromDisk(
      db,
      name,
      template.description ?? null,
      slugForEntry,
      panelFile,
      panelYaml,
    );
    await fs.writeFile(panelFile, panelYaml, "utf-8");
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function registerPanelFromDisk(
  db: CouncilDatabase,
  panelName: string,
  description: string | null,
  slugs: readonly string[],
  yamlPath: string,
  yamlContent: string,
): Promise<void> {
  const now = new Date().toISOString();
  const checksum = sha256(yamlContent);

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
        description: description,
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

interface OnDiskPanel {
  readonly description: string | null;
  readonly slugs: readonly string[];
}

function parseOnDiskPanel(content: string): OnDiskPanel {
  const raw = yaml.parse(content) as Record<string, unknown> | null;
  const description =
    raw && typeof raw["description"] === "string"
      ? (raw["description"] as string)
      : null;
  const experts = raw && Array.isArray(raw["experts"]) ? raw["experts"] : [];
  const slugs: string[] = [];
  for (const entry of experts as unknown[]) {
    if (typeof entry === "string") {
      slugs.push(entry);
    } else if (entry && typeof entry === "object" && "slug" in entry) {
      const slug = (entry as { slug: unknown }).slug;
      if (typeof slug === "string") slugs.push(slug);
    }
  }
  return { description, slugs };
}

/**
 * Document the deliberate coupling decision: this module needs access to
 * `panel_library` / `panel_members` tables, which are NOT part of the
 * abstract {@link ExpertLibrary} interface. Rather than leak `db` onto
 * `ExpertLibrary`, callers pass `CouncilDatabase` explicitly — keeping
 * the library abstraction clean while making the cross-table dependency
 * obvious at the call site.
 */

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

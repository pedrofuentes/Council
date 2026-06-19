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
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "yaml";

import type { ExpertLibrary } from "./expert-library.js";
import { ExpertDefinitionSchema, type ExpertDefinition } from "./expert.js";
import { listTemplates, loadTemplate, type ResolvedPanelDefinition } from "./template-loader.js";
import type { CouncilDatabase } from "../memory/db.js";
import { ExpertLibraryRepository } from "../memory/repositories/expert-library-repo.js";

// Mirrors FileExpertLibrary's slug constraint (kept local to avoid an
// unnecessary export). Used by the recovery path to reject malicious
// slugs read off disk before any filesystem access with that slug.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

export type MigrationNoticeWriter = (message: string) => void;

export interface MigrationOptions {
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly writeNotice?: MigrationNoticeWriter;
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
    const anyExpertRow = await db
      .selectFrom("expert_library")
      .select("slug")
      .limit(1)
      .executeTakeFirst();
    if (!anyExpertRow) return true;
    const anyPanelRow = await db
      .selectFrom("panel_library")
      .select("name")
      .limit(1)
      .executeTakeFirst();
    if (!anyPanelRow) return true;
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
  await fs.mkdir(dataHome, { recursive: true });
  // Serialise concurrent invocations (issue #303). Once the holder
  // finishes, contenders re-enter the body — by then the work is
  // already done and the existing idempotent path simply records
  // each panel as `skipped`.
  return withMigrationLock(dataHome, () =>
    runMigration(dataHome, library, db, options),
  );
}

async function runMigration(
  dataHome: string,
  library: ExpertLibrary,
  db: CouncilDatabase,
  options: MigrationOptions,
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
      // Inline expert definitions in the user-edited panel are
      // materialised into expert_library (and a standalone YAML if
      // none exists) so panel_members FK is satisfied.
      const onDiskContent = await fs.readFile(panelFile, "utf-8");
      const onDisk = parseOnDiskPanel(onDiskContent);
      const recoveredSlugs: string[] = [];
      for (const entry of onDisk.entries) {
        const candidateSlug =
          entry.kind === "slug" ? entry.slug : entry.definition.slug;
        // Hard slug validation BEFORE any filesystem access. Mirrors
        // FileExpertLibrary.create()'s SLUG_RE so a maliciously-crafted
        // user panel YAML cannot escape <dataHome>/experts/ via
        // path.join("../...") into fs.access / fs.readFile.
        if (!SLUG_RE.test(candidateSlug)) {
          throw new Error(
            `template-migration: invalid expert slug in panel "${name}": ${JSON.stringify(candidateSlug)}`,
          );
        }
        if (entry.kind === "slug") {
          recoveredSlugs.push(entry.slug);
          continue;
        }
        // Inline: ensure an expert_library row exists for this slug.
        const slug = entry.definition.slug;
        const existing = await library.get(slug);
        if (!existing) {
          const yamlPath = path.join(expertsDir, `${slug}.yaml`);
          if (await fileExists(yamlPath)) {
            const content = await fs.readFile(yamlPath, "utf-8");
            await expertRepo.create({
              slug,
              kind: entry.definition.kind,
              displayName: entry.definition.displayName,
              yamlPath,
              yamlChecksum: sha256(content),
            });
          } else {
            await library.create(entry.definition);
          }
          expertsExtracted++;
        }
        recoveredSlugs.push(slug);
      }
      await registerPanelFromDisk(
        db,
        name,
        onDisk.description,
        recoveredSlugs,
        panelFile,
        onDiskContent,
        true, // recovery: refresh existing row metadata from disk
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

  const shouldWriteNotice = options.quiet !== true && options.verbose === true;
  if (shouldWriteNotice) {
    const writeNotice =
      options.writeNotice ??
      ((message: string) => {
        process.stderr.write(message, "utf8");
      });
    writeNotice(
      `ℹ Migrated ${panelsMigrated} panels and ${expertsExtracted} experts to the new library format.\n`,
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
  refreshExisting = false,
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
  } else if (refreshExisting) {
    // Recovery path: panel row already exists (e.g. only expert tables
    // were wiped) but its description/checksum may be stale relative to
    // the user-edited YAML on disk. Re-sync from the file.
    await db
      .updateTable("panel_library")
      .set({
        description: description,
        yaml_path: yamlPath,
        yaml_checksum: checksum,
        updated_at: now,
      })
      .where("name", "=", panelName)
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
  readonly entries: readonly OnDiskEntry[];
}

type OnDiskEntry =
  | { readonly kind: "slug"; readonly slug: string }
  | { readonly kind: "inline"; readonly definition: ExpertDefinition };

function parseOnDiskPanel(content: string): OnDiskPanel {
  const raw = yaml.parse(content) as Record<string, unknown> | null;
  const description =
    raw && typeof raw["description"] === "string"
      ? (raw["description"] as string)
      : null;
  const experts = raw && Array.isArray(raw["experts"]) ? raw["experts"] : [];
  const entries: OnDiskEntry[] = [];
  for (const entry of experts as unknown[]) {
    if (typeof entry === "string") {
      entries.push({ kind: "slug", slug: entry });
    } else if (entry && typeof entry === "object") {
      // Try to parse as a full inline ExpertDefinition. If parsing fails,
      // fall back to treating it as a slug reference (the runtime
      // resolveExperts() will surface a clearer error if the slug is
      // missing).
      const parsed = ExpertDefinitionSchema.safeParse(entry);
      if (parsed.success) {
        entries.push({ kind: "inline", definition: parsed.data });
      } else if ("slug" in entry) {
        // Schema validation failed, but object has a slug field (#563).
        // Surface the validation error as a warning so the user knows
        // why the inline expert was treated as a slug reference.
        const slug = (entry as { slug: unknown }).slug;
        if (typeof slug === "string") {
          console.warn(
            `[template-migration] Inline expert with slug "${slug}" failed schema validation, treating as slug reference. Error: ${JSON.stringify(parsed.error.issues)}`,
          );
          entries.push({ kind: "slug", slug });
        }
      }
    }
  }
  return { description, entries };
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

function isEEXIST(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "EEXIST"
  );
}

const LOCK_FILENAME = ".migration.lock";
// How long (ms) we wait for a peer to release the lock before assuming
// it crashed. Bounded so a stale lock from a killed `council` process
// can't block subsequent runs forever.
const LOCK_WAIT_TIMEOUT_MS = 30_000;
// How often (ms) we re-check whether the lock file has disappeared.
const LOCK_POLL_INTERVAL_MS = 50;
// Last-resort age threshold: if a lock file's content is unreadable or
// malformed (so we can't probe holder liveness), only break it after
// this much wall-clock time has elapsed. Set high to avoid breaking
// long-running migrations from older binaries that wrote a different
// payload format.
const LOCK_FALLBACK_STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

interface LockPayload {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

/**
 * Run `fn` while holding an exclusive lock at `<dataHome>/.migration.lock`,
 * serialising concurrent template migrations across processes (issue #303).
 *
 * Uses an atomic `O_CREAT | O_EXCL` open as the lock primitive — the same
 * mechanism `proper-lockfile` uses — which is safe across local Node.js
 * processes on every supported filesystem. SQLite-level locks would not
 * suffice here because the migration also touches the filesystem
 * (`<dataHome>/experts/*.yaml`, `<dataHome>/panels/*.yaml`).
 *
 * On contention this function waits (polling) for the holder to release
 * the lock, then runs `fn` itself. The lock is always removed in a
 * `finally` block so a thrown error from `fn` does not leave behind a
 * file that would block future runs.
 *
 * Stale-lock detection probes the recorded holder PID (and hostname)
 * for liveness; we never break a lock by age alone while the owning
 * process is still running. This is what blocks the regression Sentinel
 * called out in cycle 1 of the #303 review: a migration that legitimately
 * takes longer than any age threshold would otherwise have its lock
 * deleted by a contender, reintroducing the concurrent-write race.
 */
async function withMigrationLock<T>(
  dataHome: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(dataHome, LOCK_FILENAME);
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  const payload: LockPayload = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const serialised = JSON.stringify(payload);
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(serialised, "utf-8");
      } finally {
        await handle.close();
      }
      return;
    } catch (err: unknown) {
      if (!isEEXIST(err)) throw err;
      if (await tryBreakStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `template-migration: timed out after ${LOCK_WAIT_TIMEOUT_MS}ms waiting for migration lock at ${lockPath}`,
        );
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
}

async function tryBreakStaleLock(lockPath: string): Promise<boolean> {
  let content: string;
  let mtimeMs: number;
  try {
    [content, mtimeMs] = await Promise.all([
      fs.readFile(lockPath, "utf-8"),
      fs.stat(lockPath).then((s) => s.mtimeMs),
    ]);
  } catch (err: unknown) {
    // Lock vanished between our failed open and the read — caller can
    // retry the open immediately.
    if (isENOENT(err)) return true;
    throw err;
  }

  const payload = parseLockPayload(content);
  if (payload === null) {
    // Unreadable/malformed lock from an older binary or partial write.
    // Fall back to age-based breaking with a very generous threshold.
    return await maybeEvictByAge(lockPath, mtimeMs);
  }

  const liveness = holderLiveness(payload);
  if (liveness === "dead") {
    return await unlinkIfExists(lockPath);
  }
  if (liveness === "unknown") {
    // Cross-host PID — we cannot probe liveness from here, so we
    // refuse to evict on identity alone (Sentinel #303 cycle 2). The
    // lock remains until the conservative age fallback elapses,
    // which prevents NFS/SMB-shared dataHomes from deadlocking
    // forever if a remote owner truly went away.
    return await maybeEvictByAge(lockPath, mtimeMs);
  }
  return false;
}

async function maybeEvictByAge(
  lockPath: string,
  mtimeMs: number,
): Promise<boolean> {
  if (Date.now() - mtimeMs > LOCK_FALLBACK_STALE_AFTER_MS) {
    return await unlinkIfExists(lockPath);
  }
  return false;
}

function parseLockPayload(content: string): LockPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>)["pid"] !== "number" ||
    typeof (raw as Record<string, unknown>)["hostname"] !== "string"
  ) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  return {
    pid: r["pid"] as number,
    hostname: r["hostname"] as string,
    acquiredAt: typeof r["acquiredAt"] === "string" ? (r["acquiredAt"] as string) : "",
  };
}

/**
 * Best-effort liveness probe.
 *
 * Returns:
 *   - "alive"   the holder is definitely still running
 *   - "dead"    the holder is definitely gone (safe to evict)
 *   - "unknown" we cannot prove either way — the caller should fall
 *               back to the conservative age threshold rather than
 *               evict immediately. This includes cross-host holders
 *               (a PID number from another machine is meaningless on
 *               this one) and other unexpected probe errors.
 *
 * On the local host we use `process.kill(pid, 0)`, which never sends a
 * real signal and resolves to:
 *   - success → process exists and we have permission → "alive"
 *   - EPERM   → process exists but we lack permission → "alive"
 *   - ESRCH   → no such process → "dead"
 * Any other errno code is treated as "unknown".
 */
type Liveness = "alive" | "dead" | "unknown";

function holderLiveness(payload: LockPayload): Liveness {
  if (payload.hostname !== os.hostname()) {
    // Different host. PID numbers don't apply to us — we cannot prove
    // the remote process is dead, so refuse to evict on identity
    // alone. The age-based fallback in maybeEvictByAge() still
    // ensures a truly abandoned cross-host lock is recoverable.
    return "unknown";
  }
  if (!Number.isInteger(payload.pid) || payload.pid <= 0) {
    return "unknown";
  }
  try {
    process.kill(payload.pid, 0);
    return "alive";
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code: unknown }).code;
      if (code === "ESRCH") return "dead";
      if (code === "EPERM") return "alive";
    }
    return "unknown";
  }
}

async function unlinkIfExists(p: string): Promise<boolean> {
  try {
    await fs.unlink(p);
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;
  }
  return true;
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

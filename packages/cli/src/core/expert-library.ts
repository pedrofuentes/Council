/**
 * FileExpertLibrary — YAML-file-backed CRUD for the expert library, with
 * a parallel metadata row in the `expert_library` table (migration 004).
 *
 * Each expert lives at `<dataHome>/experts/<slug>.yaml`. The DB stores the
 * slug, kind, displayName, yaml_path and a SHA-256 checksum of the YAML
 * content so the engine can detect external edits cheaply.
 *
 * Slugs are required to be URL-safe (lowercase alphanumeric plus hyphens,
 * 1..64 chars). Deletes are guarded against panel membership unless
 * `force: true` is passed.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as yaml from "yaml";

import { ExpertDefinitionSchema, type ExpertDefinition } from "./expert.js";
import { toSingleLineDisplay } from "../cli/strip-control-chars.js";
import type { CouncilDatabase } from "../memory/db.js";
import {
  ExpertLibraryRepository,
  type LibraryExpert,
} from "../memory/repositories/expert-library-repo.js";

export interface ExpertLibrary {
  /** List all experts in the library. */
  list(): Promise<readonly ExpertDefinition[]>;
  /** Get a single expert by slug, or null if not present. */
  get(slug: string): Promise<ExpertDefinition | null>;
  /** Create a new expert (writes YAML file + DB record). */
  create(def: ExpertDefinition): Promise<void>;
  /** Update an existing expert (rewrites YAML, updates DB). */
  update(slug: string, def: Partial<ExpertDefinition>): Promise<void>;
  /**
   * Delete an expert (removes YAML file + DB record). Without `force`,
   * throws when the expert is referenced by any panel. The returned
   * `affectedPanels` lists panels the expert was a member of at delete
   * time (only populated when `force: true` actually removed memberships).
   */
  delete(slug: string, options: { force: boolean }): Promise<{ affectedPanels: readonly string[] }>;
  /** Get all panels an expert belongs to. */
  panelsFor(slug: string): Promise<readonly string[]>;
  /**
   * Resolve expert slugs for a panel (loads from library, reports missing).
   */
  resolvePanel(expertSlugs: readonly string[]): Promise<{
    resolved: readonly ExpertDefinition[];
    missing: readonly string[];
  }>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG_MAX_LEN = 64;

function assertValidSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Invalid slug: must be a non-empty string`);
  }
  if (slug.length > SLUG_MAX_LEN) {
    throw new Error(`Invalid slug "${slug}": must be at most ${SLUG_MAX_LEN} characters`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}": must be lowercase alphanumeric and hyphens only (1-${SLUG_MAX_LEN} chars)`,
    );
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function serializeYaml(def: ExpertDefinition): string {
  return yaml.stringify(def);
}

function parseYaml(content: string, filePath?: string): ExpertDefinition {
  const raw = yaml.parse(content) as unknown;
  try {
    return ExpertDefinitionSchema.parse(raw);
  } catch (error) {
    const context = filePath ? ` in file: ${filePath}` : "";
    const slug = raw && typeof raw === "object" && "slug" in raw
      ? ` (slug: ${(raw as { slug: unknown }).slug})`
      : "";
    throw new Error(`Expert definition schema validation failed${context}${slug}: ${error}`);
  }
}

export class FileExpertLibrary implements ExpertLibrary {
  private readonly repo: ExpertLibraryRepository;
  private readonly expertsDir: string;

  constructor(
    dataHome: string,
    private readonly db: CouncilDatabase,
  ) {
    this.repo = new ExpertLibraryRepository(db);
    this.expertsDir = path.join(dataHome, "experts");
  }

  private yamlPathFor(slug: string): string {
    return path.join(this.expertsDir, `${slug}.yaml`);
  }

  private async repairMissingCacheRowFromYaml(slug: string, yamlPath: string): Promise<void> {
    const cached = await this.repo.findBySlug(slug);
    if (cached) {
      return;
    }
    const content = await fs.readFile(yamlPath, "utf-8");
    const parsed = parseYaml(content, yamlPath);
    if (parsed.slug !== slug) {
      throw new Error(
        `Expert YAML at ${yamlPath} declares slug "${parsed.slug}" but was expected at slug "${slug}"`,
      );
    }
    console.warn(
      `[expert-library] Recovering missing expert cache row for slug "${slug}" from existing YAML source of truth at ${yamlPath}.`,
    );
    await this.repo.create({
      slug: parsed.slug,
      kind: parsed.kind,
      displayName: parsed.displayName,
      yamlPath,
      yamlChecksum: sha256(content),
    });
  }

  async list(): Promise<readonly ExpertDefinition[]> {
    const rows = await this.repo.findAll();
    const out: ExpertDefinition[] = [];
    for (const row of rows) {
      const def = await this.readYaml(row);
      if (def) out.push(def);
    }
    return out;
  }

  async get(slug: string): Promise<ExpertDefinition | null> {
    const row = await this.repo.findBySlug(slug);
    if (!row) return null;
    return (await this.readYaml(row)) ?? null;
  }

  private async readYaml(row: LibraryExpert): Promise<ExpertDefinition | null> {
    try {
      const content = await fs.readFile(row.yamlPath, "utf-8");
      return parseYaml(content, row.yamlPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // The DB cache row exists but its backing YAML source-of-truth is
        // gone — a storage inconsistency, not a genuinely-absent expert.
        // Surface an observable diagnostic (#288) instead of silently
        // hiding the mismatch, while preserving the read contract: the
        // record still reads as absent (caller gets null / row skipped) so
        // it stays recoverable via create(). The slug and path are
        // file-derived / DB-derived and may be tampered, so sanitize them
        // for the terminal sink before display.
        const slug = toSingleLineDisplay(row.slug);
        const yamlPath = toSingleLineDisplay(row.yamlPath);
        console.warn(
          `[expert-library] Integrity: expert "${slug}" has a library record but its backing YAML file is missing (${yamlPath}). Treating it as absent until the file is restored or the record is removed.`,
        );
        return null;
      }
      throw err;
    }
  }

  async create(def: ExpertDefinition): Promise<void> {
    assertValidSlug(def.slug);
    let validated: ExpertDefinition;
    try {
      validated = ExpertDefinitionSchema.parse(def);
    } catch (error) {
      throw new Error(`Expert definition validation failed for slug "${def.slug}": ${error}`);
    }

    const yamlPath = this.yamlPathFor(validated.slug);
    await fs.mkdir(this.expertsDir, { recursive: true });
    const content = serializeYaml(validated);
    try {
      await fs.writeFile(yamlPath, content, { encoding: "utf-8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          await this.repairMissingCacheRowFromYaml(validated.slug, yamlPath);
        } catch (repairError) {
          const detail = repairError instanceof Error ? repairError.message : String(repairError);
          console.warn(
            `[expert-library] Failed to repair missing expert cache row for slug "${validated.slug}" from ${yamlPath}: ${detail}`,
          );
        }
        throw new Error(`Expert "${validated.slug}" already exists at ${yamlPath}`);
      }
      throw err;
    }

    const cached = await this.repo.findBySlug(validated.slug);
    if (cached) {
      console.warn(
        `[expert-library] Recovering stale expert cache row for slug "${validated.slug}" because ${yamlPath} was missing; rewriting metadata from YAML source of truth.`,
      );
    }
    try {
      await this.repo.create({
        slug: validated.slug,
        kind: validated.kind,
        displayName: validated.displayName,
        yamlPath,
        yamlChecksum: sha256(content),
      });
    } catch (err) {
      // Compensating action: remove the claimed YAML so caller can retry.
      // If the rollback itself fails, surface BOTH errors via AggregateError
      // so callers know storage is inconsistent.
      const restoreErrors: Error[] = [];
      await fs
        .unlink(yamlPath)
        .catch((e: unknown) => restoreErrors.push(e instanceof Error ? e : new Error(String(e))));
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [err as Error, ...restoreErrors],
          `Failed to persist expert "${validated.slug}" metadata and YAML cleanup failed — storage may be inconsistent`,
        );
      }
      throw err;
    }
  }

  async update(slug: string, patch: Partial<ExpertDefinition>): Promise<void> {
    assertValidSlug(slug);
    const current = await this.get(slug);
    if (!current) {
      throw new Error(`Expert "${slug}" not found`);
    }
    const merged: ExpertDefinition = ExpertDefinitionSchema.parse({
      ...current,
      ...patch,
      slug: current.slug,
    });
    const yamlPath = this.yamlPathFor(slug);
    const content = serializeYaml(merged);
    // Snapshot the previous YAML so a DB failure (after the write) can
    // restore the file content. Read-and-keep is cheaper than a copy file.
    let previousContent: string | null = null;
    try {
      previousContent = await fs.readFile(yamlPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    await fs.writeFile(yamlPath, content, "utf-8");
    try {
      await this.repo.update(slug, {
        kind: merged.kind,
        displayName: merged.displayName,
        yamlPath,
        yamlChecksum: sha256(content),
      });
    } catch (err) {
      // Restore the on-disk YAML to its prior state so library reads stay
      // consistent with the DB row that did NOT get updated. If the
      // restore itself fails, surface BOTH errors via AggregateError so
      // callers know storage is inconsistent.
      const restoreErrors: Error[] = [];
      if (previousContent !== null) {
        await fs
          .writeFile(yamlPath, previousContent, "utf-8")
          .catch((e: unknown) => restoreErrors.push(e instanceof Error ? e : new Error(String(e))));
      } else {
        await fs
          .unlink(yamlPath)
          .catch((e: unknown) => restoreErrors.push(e instanceof Error ? e : new Error(String(e))));
      }
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [err as Error, ...restoreErrors],
          `Failed to update expert "${slug}" and YAML restore failed — storage may be inconsistent`,
        );
      }
      throw err;
    }
  }

  async delete(
    slug: string,
    options: { force: boolean },
  ): Promise<{ affectedPanels: readonly string[] }> {
    const existing = await this.repo.findBySlug(slug);
    if (!existing) {
      throw new Error(`Expert "${slug}" not found`);
    }
    const panels = await this.repo.findPanelsForExpert(slug);
    if (panels.length > 0 && !options.force) {
      throw new Error(
        `Expert "${slug}" is a member of panels: ${panels.join(", ")}. Pass { force: true } to delete anyway.`,
      );
    }

    const yamlPath = existing.yamlPath;
    // Snapshot membership rows BEFORE the DB delete: ON DELETE CASCADE on
    // panel_members will wipe them when expert_library is deleted, so we
    // need the snapshot to restore relational state if the unlink fails.
    const memberSnapshot = await this.db
      .selectFrom("panel_members")
      .selectAll()
      .where("expert_slug", "=", slug)
      .execute();

    await this.repo.delete(slug);
    try {
      await fs.unlink(yamlPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Compensating action: recreate the expert row and restore every
        // membership the cascade deleted. Capture failures from the
        // restore path and surface them via AggregateError so callers see
        // both the original unlink failure AND any partial-restore state.
        const restoreErrors: Error[] = [];
        await this.repo
          .create({
            slug: existing.slug,
            kind: existing.kind,
            displayName: existing.displayName,
            yamlPath: existing.yamlPath,
            yamlChecksum: existing.yamlChecksum,
          })
          .catch((e: unknown) => restoreErrors.push(e instanceof Error ? e : new Error(String(e))));
        for (const m of memberSnapshot) {
          await this.db
            .insertInto("panel_members")
            .values({
              panel_name: m.panel_name,
              expert_slug: m.expert_slug,
              position: m.position,
              created_at: m.created_at,
            })
            .execute()
            .catch((e: unknown) =>
              restoreErrors.push(e instanceof Error ? e : new Error(String(e))),
            );
        }
        if (restoreErrors.length > 0) {
          throw new AggregateError(
            [err as Error, ...restoreErrors],
            `Failed to delete expert "${slug}" and rollback partially failed (${restoreErrors.length} restore error(s)) — storage may be inconsistent`,
          );
        }
        throw err;
      }
    }
    return { affectedPanels: panels };
  }

  async panelsFor(slug: string): Promise<readonly string[]> {
    return this.repo.findPanelsForExpert(slug);
  }

  async resolvePanel(expertSlugs: readonly string[]): Promise<{
    resolved: readonly ExpertDefinition[];
    missing: readonly string[];
  }> {
    const resolved: ExpertDefinition[] = [];
    const missing: string[] = [];
    for (const slug of expertSlugs) {
      const def = await this.get(slug);
      if (def) resolved.push(def);
      else missing.push(slug);
    }
    return { resolved, missing };
  }
}

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

function parseYaml(content: string): ExpertDefinition {
  const raw = yaml.parse(content) as unknown;
  return ExpertDefinitionSchema.parse(raw);
}

export class FileExpertLibrary implements ExpertLibrary {
  private readonly repo: ExpertLibraryRepository;
  private readonly expertsDir: string;

  constructor(dataHome: string, db: CouncilDatabase) {
    this.repo = new ExpertLibraryRepository(db);
    this.expertsDir = path.join(dataHome, "experts");
  }

  private yamlPathFor(slug: string): string {
    return path.join(this.expertsDir, `${slug}.yaml`);
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
      return parseYaml(content);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  async create(def: ExpertDefinition): Promise<void> {
    assertValidSlug(def.slug);
    const validated = ExpertDefinitionSchema.parse(def);

    const existing = await this.repo.findBySlug(validated.slug);
    if (existing) {
      throw new Error(`Expert "${validated.slug}" already exists`);
    }
    const yamlPath = this.yamlPathFor(validated.slug);
    try {
      await fs.access(yamlPath);
      throw new Error(`Expert "${validated.slug}" already exists at ${yamlPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        if ((err as Error).message?.includes("already exists")) throw err;
        // fall through — best-effort
      }
    }

    await fs.mkdir(this.expertsDir, { recursive: true });
    const content = serializeYaml(validated);
    await fs.writeFile(yamlPath, content, "utf-8");

    await this.repo.create({
      slug: validated.slug,
      kind: validated.kind,
      displayName: validated.displayName,
      yamlPath,
      yamlChecksum: sha256(content),
    });
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
    await fs.writeFile(yamlPath, content, "utf-8");

    await this.repo.update(slug, {
      kind: merged.kind,
      displayName: merged.displayName,
      yamlPath,
      yamlChecksum: sha256(content),
    });
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
    try {
      await fs.unlink(yamlPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    await this.repo.delete(slug);
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

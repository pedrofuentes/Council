/**
 * `council panel create|list|inspect|edit` (Roadmap 4.4)
 *
 * Manages the user's YAML-based panel library at `<dataHome>/panels/`.
 * Distinct from the existing `council panels` command, which lists
 * runtime panels from the debate DB.
 *
 * Each panel YAML references library experts by slug, e.g.:
 *
 *   name: arch-review
 *   description: "Multi-perspective review"
 *   defaults:
 *     mode: freeform
 *     maxRounds: 4
 *   experts:
 *     - cto
 *     - staff
 *
 * Subcommands share a helper that opens the Council DB + ExpertLibrary
 * + PanelLibraryRepository and tears the DB down on exit.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Command } from "commander";
import * as yaml from "yaml";

import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  type CouncilConfig,
} from "../../config/index.js";
import { FileExpertLibrary, type ExpertLibrary } from "../../core/expert-library.js";
import type { ExpertDefinition } from "../../core/expert.js";
import {
  DEBATE_MODES,
  PanelDefinitionSchema,
  PanelNotFoundError,
  listUserPanels,
  loadUserPanel,
  type DebateMode,
  type PanelDefinition,
} from "../../core/template-loader.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { PanelLibraryRepository } from "../../memory/repositories/panel-library-repo.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const PANEL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

interface PanelContext {
  readonly library: ExpertLibrary;
  readonly panels: PanelLibraryRepository;
  readonly config: CouncilConfig;
  readonly dataHome: string;
  readonly db: CouncilDatabase;
}

async function withPanelContext<T>(fn: (ctx: PanelContext) => Promise<T>): Promise<T> {
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);
  const library = new FileExpertLibrary(dataHome, db);
  const panels = new PanelLibraryRepository(db);
  try {
    return await fn({ library, panels, config, dataHome, db });
  } finally {
    await db.destroy();
  }
}

function displayPath(absPath: string): string {
  const home = os.homedir();
  if (absPath.startsWith(home)) {
    return "~" + absPath.slice(home.length).replace(/\\/g, "/");
  }
  return absPath;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function panelYamlPath(dataHome: string, name: string): string {
  return path.join(dataHome, "panels", `${name}.yaml`);
}

/**
 * Resolve the on-disk panel YAML path, preferring `.yaml` then `.yml`.
 * Returns null when neither extension exists. Used by inspect/edit so a
 * panel authored as `<name>.yml` is operated on in place rather than
 * silently shadowed by a sibling `<name>.yaml`.
 */
async function resolveExistingPanelYamlPath(
  dataHome: string,
  name: string,
): Promise<string | null> {
  const dir = path.join(dataHome, "panels");
  for (const ext of ["yaml", "yml"] as const) {
    const candidate = path.join(dir, `${name}.${ext}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function validatePanelName(name: string): void {
  if (!PANEL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid panel name "${name}": must be lowercase alphanumeric and hyphens only, start with a letter, 1-64 chars`,
    );
  }
}

function entrySlug(entry: PanelDefinition["experts"][number]): string {
  return typeof entry === "string" ? entry : entry.slug;
}

function serializePanelYaml(def: PanelDefinition): string {
  // Strip undefined keys for tidy output.
  const out: Record<string, unknown> = { name: def.name };
  if (def.description !== undefined) out["description"] = def.description;
  if (def.defaults !== undefined) {
    const defaults: Record<string, unknown> = { mode: def.defaults.mode };
    if (def.defaults.maxRounds !== undefined) defaults["maxRounds"] = def.defaults.maxRounds;
    out["defaults"] = defaults;
  }
  out["experts"] = def.experts;
  return yaml.stringify(out);
}

export function buildPanelCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
): Command {
  const cmd = new Command("panel");
  cmd.description("Manage Council's panel library (create, list, inspect, edit)");
  cmd.addCommand(buildCreateCommand(write, writeError));
  cmd.addCommand(buildListCommand(write));
  cmd.addCommand(buildInspectCommand(write, writeError));
  cmd.addCommand(buildEditCommand(write, writeError));
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────────

interface CreateOptions {
  readonly experts?: string;
  readonly mode?: string;
  readonly maxRounds?: string;
  readonly description?: string;
}

function buildCreateCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("create");
  cmd
    .description("Create a new panel by selecting experts from the library")
    .argument("<name>", "Panel name (kebab-case)")
    .option("--experts <slugs>", "Comma-separated expert slugs (or numeric indices from list)")
    .option("--mode <mode>", "Debate mode: freeform | structured (default freeform)")
    .option("--max-rounds <n>", "Default max rounds (1-20, default 4)")
    .option("--description <text>", "Optional panel description")
    .action(async (name: string, opts: CreateOptions) => {
      validatePanelName(name);

      await withPanelContext(async (ctx) => {
        const existing = await ctx.panels.findByName(name);
        if (existing) {
          const msg = `Panel "${name}" already exists.`;
          writeError(msg + "\n");
          throw new Error(msg);
        }

        const availableExperts = await ctx.library.list();
        if (availableExperts.length === 0) {
          const msg = `No experts in library. Create experts first with "council expert create".`;
          writeError(msg + "\n");
          throw new Error(msg);
        }

        const fields = await gatherCreateFields(opts, availableExperts, write);

        // Resolve selections (either numbers or slugs) to canonical slugs.
        const selectedSlugs = resolveExpertSelection(fields.experts, availableExperts);

        // Verify each slug exists.
        const missing: string[] = [];
        for (const slug of selectedSlugs) {
          if (!availableExperts.some((e) => e.slug === slug)) missing.push(slug);
        }
        if (missing.length > 0) {
          const msg = `Expert(s) not found in library: ${missing.join(", ")}`;
          writeError(msg + "\n");
          throw new Error(msg);
        }

        const definition: PanelDefinition = PanelDefinitionSchema.parse({
          name,
          ...(fields.description ? { description: fields.description } : {}),
          defaults: {
            mode: fields.mode,
            maxRounds: fields.maxRounds,
          },
          experts: selectedSlugs,
        });

        const yamlPath = panelYamlPath(ctx.dataHome, name);
        await fs.mkdir(path.dirname(yamlPath), { recursive: true });
        const content = serializePanelYaml(definition);

        // DB insert first so a YAML write failure can roll back.
        await ctx.panels.create({
          name,
          ...(fields.description ? { description: fields.description } : {}),
          yamlPath,
          yamlChecksum: sha256(content),
        });
        let yamlWritten = false;
        try {
          await fs.writeFile(yamlPath, content, "utf-8");
          yamlWritten = true;
          await ctx.panels.setMembers(name, selectedSlugs);
        } catch (err) {
          const rollbackErrors: Error[] = [];
          await ctx.panels.delete(name).catch((e: unknown) => {
            rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
          });
          if (yamlWritten) {
            await fs.unlink(yamlPath).catch((e: unknown) => {
              const code = (e as NodeJS.ErrnoException).code;
              if (code !== "ENOENT") {
                rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
              }
            });
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [err as Error, ...rollbackErrors],
              `Failed to create panel "${name}" and rollback partially failed — storage may be inconsistent`,
            );
          }
          throw err;
        }

        write(
          `✓ Panel "${name}" created with ${selectedSlugs.length} expert${selectedSlugs.length === 1 ? "" : "s"} at ${displayPath(yamlPath)}\n`,
        );
      });
    });
  return cmd;
}

interface CreateFields {
  readonly experts: readonly string[];
  readonly mode: DebateMode;
  readonly maxRounds: number;
  readonly description?: string;
}

function parseModeFlag(raw: string | undefined): DebateMode {
  if (raw === undefined) return "freeform";
  const trimmed = raw.trim();
  if (!(DEBATE_MODES as readonly string[]).includes(trimmed)) {
    throw new Error(`Invalid --mode value "${raw}". Expected one of: ${DEBATE_MODES.join(", ")}`);
  }
  return trimmed as DebateMode;
}

function parseMaxRoundsFlag(raw: string | undefined): number {
  if (raw === undefined) return 4;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new Error(`Invalid --max-rounds value "${raw}". Expected integer 1-20.`);
  }
  return n;
}

async function gatherCreateFields(
  opts: CreateOptions,
  available: readonly ExpertDefinition[],
  write: Writer,
): Promise<CreateFields> {
  // Non-interactive path: --experts provided.
  if (opts.experts !== undefined) {
    const selections = opts.experts
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (selections.length === 0) {
      throw new Error("--experts must list at least one slug or index");
    }
    return {
      experts: selections,
      mode: parseModeFlag(opts.mode),
      maxRounds: parseMaxRoundsFlag(opts.maxRounds),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    };
  }

  // Interactive wizard.
  const rl = readline.createInterface({ input, output });
  try {
    write("Creating a new panel. Press Ctrl+C to abort.\n\n");
    const description =
      opts.description ?? (await rl.question("description (optional, blank to skip): ")).trim();

    write("\nAvailable experts:\n");
    available.forEach((e, i) => {
      write(`  ${i + 1}. ${e.slug} (${e.displayName} - ${e.role})\n`);
    });
    write("\n");

    let selections: string[] = [];
    while (selections.length === 0) {
      const answer = (
        await rl.question("Select experts (numbers or slugs, comma-separated): ")
      ).trim();
      selections = answer
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (selections.length === 0) write("Select at least one expert.\n");
    }

    const modeAnswer =
      opts.mode ??
      ((await rl.question(`mode (freeform | structured) [freeform]: `)).trim() || "freeform");
    const maxRoundsAnswer =
      opts.maxRounds ?? ((await rl.question(`maxRounds [4]: `)).trim() || "4");

    return {
      experts: selections,
      mode: parseModeFlag(modeAnswer),
      maxRounds: parseMaxRoundsFlag(maxRoundsAnswer),
      ...(description ? { description } : {}),
    };
  } finally {
    rl.close();
  }
}

function resolveExpertSelection(
  selections: readonly string[],
  available: readonly ExpertDefinition[],
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sel of selections) {
    let slug: string;
    if (/^\d+$/.test(sel)) {
      const idx = Number(sel) - 1;
      const expert = available[idx];
      if (!expert) {
        throw new Error(`Expert index ${sel} out of range (1-${available.length})`);
      }
      slug = expert.slug;
    } else {
      slug = sel;
    }
    if (seen.has(slug)) {
      throw new Error(`Duplicate expert "${slug}" in selection`);
    }
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────────

function buildListCommand(write: Writer): Command {
  const cmd = new Command("list");
  cmd
    .description("List all user-created panels")
    .option("--format <kind>", "Output format: table (default) or json", "table")
    .action(async (raw: { format?: string }) => {
      if (raw.format !== undefined && raw.format !== "table" && raw.format !== "json") {
        throw new Error(`Unknown --format value: ${raw.format}. Expected one of: table, json`);
      }
      const format: "table" | "json" = raw.format === "json" ? "json" : "table";

      await withPanelContext(async (ctx) => {
        const names = await listUserPanels(ctx.dataHome);

        const entries = await Promise.all(
          names.map(async (name) => {
            const def = await loadUserPanel(name, ctx.dataHome);
            const slugs = def.experts.map(entrySlug);
            return {
              name: def.name,
              description: def.description ?? "",
              experts: slugs,
              expertCount: slugs.length,
            };
          }),
        );

        if (format === "json") {
          write(JSON.stringify(entries, null, 2) + "\n");
          return;
        }

        if (entries.length === 0) {
          write('No panels found. Create one with "council panel create".\n');
          return;
        }

        const rows: readonly (readonly string[])[] = entries.map((e) => [
          e.name,
          String(e.expertCount),
          e.experts.join(","),
          e.description,
        ]);
        const header = ["name", "experts", "members", "description"] as const;
        const widths = header.map((h, i) =>
          Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
        );
        const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
        write(header.map((h, i) => pad(h, widths[i] ?? 0)).join("  ") + "\n");
        write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
        for (const row of rows) {
          write(row.map((c, i) => pad(c, widths[i] ?? 0)).join("  ") + "\n");
        }
      });
    });
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// inspect
// ──────────────────────────────────────────────────────────────────────

function buildInspectCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("inspect");
  cmd
    .description("Show full detail for a single panel")
    .argument("<name>", "Panel name to inspect")
    .action(async (name: string) => {
      await withPanelContext(async (ctx) => {
        let def: PanelDefinition;
        try {
          def = await loadUserPanel(name, ctx.dataHome);
        } catch (err) {
          if (err instanceof PanelNotFoundError) {
            const msg = `Panel "${name}" not found.`;
            writeError(msg + "\n");
            throw new Error(msg);
          }
          throw err;
        }
        const yamlPath =
          (await resolveExistingPanelYamlPath(ctx.dataHome, name)) ??
          panelYamlPath(ctx.dataHome, name);
        const slugs = def.experts.map(entrySlug);

        write(`Panel: ${def.name}\n`);
        if (def.description) write(`Description: ${def.description}\n`);
        write(`Mode: ${def.defaults?.mode ?? "freeform"}\n`);
        write(`Max Rounds: ${def.defaults?.maxRounds ?? 4}\n`);
        write(`File: ${displayPath(yamlPath)}\n`);
        write("\n");
        write(`Experts (${slugs.length}):\n`);
        for (let i = 0; i < def.experts.length; i++) {
          const entry = def.experts[i];
          const slug = entrySlug(entry as PanelDefinition["experts"][number]);
          const expert = typeof entry === "string" ? await ctx.library.get(slug) : entry;
          if (expert) {
            write(
              `  ${i + 1}. ${expert.slug} — ${expert.displayName} (${expert.role}) [${expert.kind}]\n`,
            );
          } else {
            write(`  ${i + 1}. ${slug} — (missing from library)\n`);
          }
        }
      });
    });
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// edit
// ──────────────────────────────────────────────────────────────────────

function buildEditCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("edit");
  cmd
    .description("Open the panel YAML in $EDITOR and re-validate on save")
    .argument("<name>", "Panel name to edit")
    .action(async (name: string) => {
      await withPanelContext(async (ctx) => {
        // Confirm panel exists and resolve its actual on-disk file (.yaml or .yml).
        try {
          await loadUserPanel(name, ctx.dataHome);
        } catch (err) {
          if (err instanceof PanelNotFoundError) {
            const msg = `Panel "${name}" not found.`;
            writeError(msg + "\n");
            throw new Error(msg);
          }
          throw err;
        }
        const yamlPath =
          (await resolveExistingPanelYamlPath(ctx.dataHome, name)) ??
          panelYamlPath(ctx.dataHome, name);
        const editor = resolveEditor();

        await runEditor(editor, yamlPath);

        // Re-read and validate. PanelDefinitionSchema also enforces
        // duplicate-slug detection within the experts array.
        let parsed: PanelDefinition;
        try {
          const onDisk = await fs.readFile(yamlPath, "utf-8");
          parsed = PanelDefinitionSchema.parse(yaml.parse(onDisk));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(`Validation failed after edit: ${message}\n`);
          throw err;
        }

        if (parsed.name !== name) {
          const msg = `Refusing to rename panel "${name}" → "${parsed.name}" via edit. Delete and re-create the panel to change its name.`;
          writeError(msg + "\n");
          throw new Error(msg);
        }

        // Verify referenced experts still exist in the library.
        const slugs = parsed.experts.map(entrySlug);
        const stringSlugs = parsed.experts
          .filter((e): e is string => typeof e === "string")
          .map((e) => e);
        const missing: string[] = [];
        for (const slug of stringSlugs) {
          const expert = await ctx.library.get(slug);
          if (!expert) missing.push(slug);
        }
        if (missing.length > 0) {
          const msg = `Expert(s) not found in library: ${missing.join(", ")}`;
          writeError(msg + "\n");
          throw new Error(msg);
        }

        const content = await fs.readFile(yamlPath, "utf-8");
        await ctx.panels.update(name, {
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          yamlPath,
          yamlChecksum: sha256(content),
        });
        await ctx.panels.setMembers(name, slugs);
        write(`✓ Panel "${name}" saved and validated.\n`);
      });
    });
  return cmd;
}

function resolveEditor(): string {
  const fromEnv = process.env["VISUAL"] ?? process.env["EDITOR"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return process.platform === "win32" ? "notepad" : "vi";
}

async function runEditor(editorCmd: string, filePath: string): Promise<void> {
  const parts = editorCmd.match(/(?:"[^"]*"|\S)+/g) ?? [editorCmd];
  const head = parts[0] ?? editorCmd;
  const exe = head.replace(/^"|"$/g, "");
  const args = parts
    .slice(1)
    .map((p) => p.replace(/^"|"$/g, ""))
    .concat(filePath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal !== null) {
        reject(new Error(`Editor "${exe}" was terminated by signal ${signal}`));
        return;
      }
      reject(new Error(`Editor "${exe}" exited with code ${code ?? "unknown"}`));
    });
  });
}

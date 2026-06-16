/**
 * `council panel create|list|inspect|edit` (Roadmap 4.4)
 *
 * Library-based panel composition. Panels live as YAML files at
 * `<dataHome>/panels/<name>.yaml` with parallel rows in the
 * `panel_library` + `panel_members` tables. Expert references use slugs
 * that resolve through the FileExpertLibrary.
 *
 * Mirrors the structure of `expert.ts` — interactive prompts via
 * `node:readline/promises` with full non-interactive flag coverage so the
 * commands are testable in non-TTY environments.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Command, Option } from "commander";
import { z } from "zod";

import { CliUserError } from "../cli-user-error.js";
import { parseExpertSlugs, warnOnStrayExpertArgs } from "./expert-args.js";
import * as yaml from "yaml";

import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  type CouncilConfig,
} from "../../config/index.js";
import { FileExpertLibrary, type ExpertLibrary } from "../../core/expert-library.js";
import {
  ExpertDefinitionSchema,
  allowlistExpertDefinition,
  type ExpertDefinition,
} from "../../core/expert.js";
import {
  DEBATE_MODES,
  PanelDefaultsSchema,
  PanelDefinitionSchema,
  type DebateMode,
  type PanelDefinition,
  type PanelExpertEntry,
} from "../../core/template-loader.js";
import { scanAndIndexPanelDocuments } from "../../core/documents/panel-document-scanner.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { PanelLibraryRepository } from "../../memory/repositories/panel-library-repo.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import {
  PanelDocumentRepository,
  type PanelDocument,
} from "../../memory/repositories/panel-document-repo.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { createReadlineConfirmProvider, type ConfirmProvider } from "./confirm.js";
import { resolveSession } from "../session-resolver.js";
import { suggestMatch } from "../fuzzy-match.js";
import { stripControlChars } from "../strip-control-chars.js";

const PANEL_NAME_RE = /^[a-z][a-z0-9-]*$/;

function formatPanelNotFound(name: string, available: readonly string[]): string {
  const suggestions = suggestMatch(name, available);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  return `Panel "${name}" not found.${hint}`;
}

/**
 * Build the confirmation message for panel deletion.
 *
 * `panel delete` removes ONLY the panel template — the `panel_library` row,
 * its `panel_members`, the YAML file, and the panel docs directory. It does
 * NOT delete debate sessions: those live in the runtime `panels`/`debates`
 * tables, which have no foreign key to `panel_library`. When the panel has
 * past debate sessions, the message surfaces the count framed as RETAINED —
 * they stay available via `council sessions`.
 *
 * @param panelName - The name of the panel to delete
 * @param debateCount - Number of past debate sessions for this panel (kept, not deleted)
 * @returns Confirmation prompt string
 */
export function buildDeleteConfirmationMessage(panelName: string, debateCount: number): string {
  let debateClause = "";
  if (debateCount > 0) {
    const noun = debateCount === 1 ? "session" : "sessions";
    const verb = debateCount === 1 ? "is" : "are";
    const stay = debateCount === 1 ? "stays" : "stay";
    debateClause = ` (Its ${debateCount} past debate ${noun} ${verb} kept and ${stay} available via 'council sessions'.)`;
  }
  return `Delete panel "${panelName}" and its documents?${debateClause} This cannot be undone. (y/N) `;
}

interface PanelContext {
  readonly library: ExpertLibrary;
  readonly panelRepo: PanelLibraryRepository;
  readonly docsRepo: PanelDocumentRepository;
  readonly runtimePanelRepo: PanelRepository;
  readonly debateRepo: DebateRepository;
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
  const panelRepo = new PanelLibraryRepository(db);
  const docsRepo = new PanelDocumentRepository(db);
  const runtimePanelRepo = new PanelRepository(db);
  const debateRepo = new DebateRepository(db);
  try {
    return await fn({
      library,
      panelRepo,
      docsRepo,
      runtimePanelRepo,
      debateRepo,
      config,
      dataHome,
      db,
    });
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

function panelDocsDir(dataHome: string, name: string): string {
  return path.join(dataHome, "panels", name, "docs");
}

function validatePanelName(name: string): void {
  if (!PANEL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid panel name "${name}": must be kebab-case (lowercase letters, digits, hyphens; must start with a letter)`,
    );
  }
}

function entrySlug(entry: PanelExpertEntry): string {
  return typeof entry === "string" ? entry : entry.slug;
}

/**
 * Persist the on-disk + relational artifacts for a library panel: the
 * `panel_library` row, the `<dataHome>/panels/<name>.yaml` file (written
 * with O_EXCL so a concurrent writer cannot be clobbered), the ordered
 * `panel_members` rows, and the panel docs directory. On any failure the
 * partial state is rolled back (row deleted, YAML unlinked).
 *
 * Extracted from `panel create` so `panel save` (T9) reuses the EXACT same
 * write path — both commands produce identical, valid library panels.
 *
 * @returns the absolute YAML path and the ordered expert slugs written.
 */
async function persistPanelArtifacts(
  ctx: PanelContext,
  panel: PanelDefinition,
  writeError: Writer,
): Promise<{ readonly yamlPath: string; readonly expertSlugs: readonly string[] }> {
  const name = panel.name;
  const expertSlugs = panel.experts.map(entrySlug);
  const yamlPath = panelYamlPath(ctx.dataHome, name);
  const yamlContent = yaml.stringify(panel);
  const checksum = sha256(yamlContent);

  // DB row first so a YAML write failure can roll back cleanly.
  await ctx.panelRepo.create({
    name,
    description: panel.description ?? null,
    yamlPath,
    yamlChecksum: checksum,
  });
  let yamlWritten = false;
  try {
    await fs.mkdir(path.dirname(yamlPath), { recursive: true });
    // O_EXCL: fail if another concurrent create already wrote here.
    // Split open from write so a mid-write failure (ENOSPC, EIO, …)
    // still triggers rollback of the file we just created.
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(yamlPath, "wx");
    } catch (openErr) {
      if ((openErr as NodeJS.ErrnoException).code === "EEXIST") {
        writeError(`Panel YAML already exists at ${displayPath(yamlPath)}\n`);
        throw new CliUserError(`Panel "${name}" already exists at ${yamlPath}`);
      }
      throw openErr;
    }
    yamlWritten = true;
    try {
      await handle.writeFile(yamlContent, "utf-8");
    } catch (writeErr) {
      // Preserve the primary write failure if close() also fails —
      // a secondary close error must not mask the ENOSPC/EIO root
      // cause the operator needs to see.
      try {
        await handle.close();
      } catch {
        /* swallow secondary cleanup error */
      }
      throw writeErr;
    }
    await handle.close();
    await ctx.panelRepo.setMembers(name, expertSlugs);
    await fs.mkdir(panelDocsDir(ctx.dataHome, name), { recursive: true });
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    try {
      await ctx.panelRepo.delete(name);
    } catch (deleteErr) {
      rollbackErrors.push(deleteErr);
    }
    // Only unlink the YAML if we are the writer that created it; an
    // EEXIST collision means the file belongs to another process.
    if (yamlWritten) {
      try {
        await fs.unlink(yamlPath);
      } catch (unlinkErr) {
        const code = (unlinkErr as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") rollbackErrors.push(unlinkErr);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [err, ...rollbackErrors],
        `Failed to create panel "${name}" and rollback also failed — storage may be inconsistent`,
      );
    }
    throw err;
  }
  return { yamlPath, expertSlugs };
}

export function buildPanelCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
  confirmProvider?: ConfirmProvider,
): Command {
  const cmd = new Command("panel");
  cmd.alias("panels");
  cmd.description("Manage Council panels (create, list, inspect, edit, delete)");
  cmd.action(async () => {
    await runPanelList(write, "table", false);
  });
  cmd.addCommand(buildCreateCommand(write, writeError));
  cmd.addCommand(buildSaveCommand(write, writeError));
  cmd.addCommand(buildListCommand(write));
  cmd.addCommand(buildInspectCommand(write, writeError));
  cmd.addCommand(buildEditCommand(write, writeError));
  cmd.addCommand(buildDeleteCommand(write, writeError, confirmProvider));
  cmd.addCommand(buildDocsCommand(write, writeError, confirmProvider));
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// delete (T2)
// ──────────────────────────────────────────────────────────────────────

function buildDeleteCommand(
  write: Writer,
  writeError: Writer,
  confirmProvider?: ConfirmProvider,
): Command {
  const cmd = new Command("delete");
  cmd
    .description("Delete a panel (YAML file, docs directory, and DB rows)")
    .argument("<name>", "Panel name to delete")
    .option("--yes", "Skip the confirmation prompt (non-interactive runs)")
    .addOption(
      new Option("--force", "Skip the confirmation prompt (non-interactive runs)").hideHelp(),
    )
    .action(async (name: string, opts: { force?: boolean; yes?: boolean }) => {
      // Defense in depth: re-validate the panel name on every fs.rm/unlink
      // path. Create-time validation cannot be relied upon because the
      // `panel_library.name` column could be populated via migration,
      // import, or direct DB edit; any such channel that bypassed
      // `PANEL_NAME_RE` would otherwise let `fs.rm({recursive,force})`
      // wipe arbitrary directories.
      validatePanelName(name);

      await withPanelContext(async (ctx) => {
        const existing = await ctx.panelRepo.findByName(name);
        if (!existing) {
          const all = (await ctx.panelRepo.findAll()).map((p) => p.name);
          const msg = formatPanelNotFound(name, all);
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }

        // Count the panel's past debate sessions so the confirmation can state how many are
        // KEPT. The panels table holds runtime instances (created when debates start); a
        // panel_library entry may have multiple runtime panel rows with the same name. These
        // debates are NOT deleted by `panel delete`: debates CASCADE off the runtime
        // panels(id), which this command never touches (it only removes the panel_library row,
        // panel_members, the YAML, and the docs dir). They remain available via `council
        // sessions`.
        const runtimePanels = await ctx.runtimePanelRepo.findByNamePrefix(name);
        const exactMatches = runtimePanels.filter((p) => p.name === name);
        let debateCount = 0;
        for (const panel of exactMatches) {
          debateCount += (await ctx.debateRepo.findByPanelId(panel.id)).length;
        }

        if (opts.yes !== true && opts.force !== true) {
          const provider = confirmProvider ?? createReadlineConfirmProvider();
          const confirmMessage = buildDeleteConfirmationMessage(name, debateCount);
          const ok = await provider.confirm(confirmMessage);
          if (!ok) {
            const msg = `Aborted: panel "${name}" not deleted.`;
            writeError(msg + "\n");
            throw new CliUserError(msg);
          }
        }

        // Defense in depth: assert resolved paths stay under
        // <dataHome>/panels/ even if validatePanelName ever weakens.
        const panelsRoot = path.resolve(path.join(ctx.dataHome, "panels"));
        const yamlPath = panelYamlPath(ctx.dataHome, name);
        const panelDir = path.join(ctx.dataHome, "panels", name);
        const resolvedYaml = path.resolve(yamlPath);
        const resolvedDir = path.resolve(panelDir);
        const rootPrefix = panelsRoot + path.sep;
        if (!resolvedYaml.startsWith(rootPrefix) || !resolvedDir.startsWith(rootPrefix)) {
          const msg = `Refusing to delete: resolved path escapes panels directory (name="${name}")`;
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }

        // Order matters: filesystem first, DB row last. If unlink fails
        // (EBUSY on Windows when the YAML is open in an editor, EPERM,
        // EIO, …) the DB row remains authoritative so the operator can
        // close the file and re-run `panel delete` to clean up. A
        // DB-first ordering would silently destroy panel_members rows
        // before the on-disk failure surfaced, trapping the user with
        // an orphan YAML that the CLI could no longer reach.
        try {
          await fs.unlink(yamlPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            writeError(
              `Failed to delete YAML at ${displayPath(yamlPath)}: ${
                err instanceof Error ? err.message : String(err)
              }\nDB rows preserved; re-run \`council panel delete ${name}\` after fixing.\n`,
            );
            throw err;
          }
        }

        // Per spec the docs live at <dataHome>/panels/<name>/docs — but
        // the parent <dataHome>/panels/<name> directory may also hold
        // other generated artifacts. Remove the whole panel-scoped
        // directory tree to avoid orphaned files. fs.rm with force:true
        // already tolerates ENOENT, so a missing dir is not a failure.
        try {
          await fs.rm(panelDir, { recursive: true, force: true });
        } catch (err) {
          writeError(
            `Warning: failed to clean up ${displayPath(panelDir)}: ${
              err instanceof Error ? err.message : String(err)
            }\nDB rows preserved; re-run \`council panel delete ${name}\` after fixing.\n`,
          );
          throw err;
        }

        // Filesystem cleanup succeeded — now safe to drop the DB row
        // (ON DELETE CASCADE wipes panel_members atomically).
        await ctx.panelRepo.delete(name);

        write(`✓ Panel "${name}" deleted.\n`);
        write("\x1b[2mRun 'council panel list' to verify.\x1b[0m\n");
      });
    });
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────────

interface CreateOptions {
  readonly slug?: string;
  readonly experts?: string | readonly string[];
  readonly mode?: string;
  readonly maxRounds?: string;
  readonly model?: string;
  readonly description?: string;
}

function buildCreateCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("create");
  cmd
    .description(
      "Create a new panel with library experts. If `council convene` runs without `--template`, Council auto-composes a panel for you.",
    )
    .argument("[name]", "Panel name (kebab-case). Alias: --slug")
    .option("--slug <slug>", "Panel name (kebab-case). Alias for the positional <name> argument.")
    .option(
      "--experts <slugs...>",
      "Expert slugs from the library (space- or comma-separated, repeatable)",
    )
    .option("--mode <mode>", `Debate mode: ${DEBATE_MODES.join(" | ")}`)
    .option("--max-rounds <n>", "Maximum debate rounds (1-20)")
    .option("--model <model>", "Default model for all experts in this panel")
    .option("--description <text>", "One-line description")
    .action(async (positionalName: string | undefined, opts: CreateOptions, command: Command) => {
      warnOnStrayExpertArgs(command, writeError);
      if (positionalName !== undefined && opts.slug !== undefined) {
        writeError("Cannot use both positional <name> and --slug. Pass one or the other.\n");
        throw new CliUserError(
          "panel create: both positional <name> and --slug were provided; pass only one.",
        );
      }
      const name = positionalName ?? opts.slug;
      if (name === undefined || name.length === 0) {
        writeError("Panel name is required. Pass it as the positional argument or with --slug.\n");
        throw new CliUserError("panel create: missing panel name (positional <name> or --slug).");
      }
      validatePanelName(name);

      await withPanelContext(async (ctx) => {
        const existingRow = await ctx.panelRepo.findByName(name);
        if (existingRow) {
          writeError(
            `Panel "${name}" already exists. Use "council panel edit ${name}" to modify or choose a different name.\n`,
          );
          throw new CliUserError(`Panel "${name}" already exists`);
        }

        const fields = await gatherCreateFields(opts, ctx.library, write, writeError);

        const mode: DebateMode = fields.mode;
        const defaults: { mode: DebateMode; maxRounds?: number; model?: string } = { mode };
        if (fields.maxRounds !== undefined) defaults.maxRounds = fields.maxRounds;
        if (opts.model !== undefined) defaults.model = opts.model;

        const panel: PanelDefinition = PanelDefinitionSchema.parse({
          name,
          ...(fields.description ? { description: fields.description } : {}),
          defaults,
          experts: fields.expertSlugs,
        });

        const { yamlPath } = await persistPanelArtifacts(ctx, panel, writeError);

        write(`✓ Panel "${name}" created at ${displayPath(yamlPath)}\n`);
        write(`  Experts: ${fields.expertSlugs.join(", ")}\n`);
      });
    });
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// save (T9) — promote a debate session into a reusable library panel
// ──────────────────────────────────────────────────────────────────────

/**
 * Schema for the `ResolvedPanelDefinition` that `council convene` stores in
 * a session's `config_json.definition`. Experts MUST be fully inline (the
 * promotion creates real library experts from them) — a slug-string entry
 * would have nothing to promote.
 */
const StoredPanelDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  defaults: PanelDefaultsSchema.optional(),
  experts: z.array(ExpertDefinitionSchema).min(1).max(8),
});

type StoredDefinition = z.infer<typeof StoredPanelDefinitionSchema>;

type StoredDefinitionResult =
  | { readonly kind: "ok"; readonly definition: StoredDefinition }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Read and validate the stored panel definition from a session's
 * `config_json`. Distinguishes three cases so the command can emit a
 * precise error: the key is absent (older session, predates the enabler),
 * present-but-malformed (corrupt), or a usable definition.
 */
function parseStoredDefinition(configJson: string): StoredDefinitionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return { kind: "absent" };
  }
  if (parsed === null || typeof parsed !== "object" || !("definition" in parsed)) {
    return { kind: "absent" };
  }
  const definition = (parsed as { definition: unknown }).definition;
  if (definition === undefined || definition === null) {
    return { kind: "absent" };
  }
  const result = StoredPanelDefinitionSchema.safeParse(definition);
  if (!result.success) {
    return { kind: "invalid", message: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { kind: "ok", definition: result.data };
}

/**
 * Lowercase-kebab a composed panel name so it satisfies {@link PANEL_NAME_RE}
 * (must start with a letter). Used to derive a default library name when the
 * user does not pass one to `panel save`.
 */
function slugifyPanelName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length === 0) return "panel";
  return /^[a-z]/.test(base) ? base : `panel-${base}`;
}

/**
 * Find a free library panel name by suffixing `-2`, `-3`, … when `base`
 * (or a candidate) already exists as a `panel_library` row or YAML file.
 * Non-destructive: promotion never clobbers an existing panel.
 */
async function assignFreePanelName(ctx: PanelContext, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  for (;;) {
    const rowExists = (await ctx.panelRepo.findByName(candidate)) !== undefined;
    const fileExists = await pathExists(panelYamlPath(ctx.dataHome, candidate));
    if (!rowExists && !fileExists) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
}

/**
 * Find a free expert slug by suffixing `-2`, `-3`, … when `base` already
 * exists in the library or has been claimed earlier in THIS promotion
 * (`taken` guards against intra-batch collisions when two source experts
 * resolve to the same slug).
 */
async function assignFreeExpertSlug(
  ctx: PanelContext,
  base: string,
  taken: ReadonlySet<string>,
): Promise<string> {
  let candidate = base;
  let n = 2;
  for (;;) {
    const inLibrary = (await ctx.library.get(candidate)) !== null;
    if (!taken.has(candidate) && !inLibrary) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

interface SaveOptions {
  readonly latest?: boolean;
}

function buildSaveCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("save");
  cmd
    .description(
      "Promote a debate session (e.g. an auto-composed `convene` run) into a reusable library panel + experts.",
    )
    .argument("[session]", "Session name or unique prefix to promote (omit when using --latest)")
    .argument(
      "[name]",
      "Name for the new library panel (kebab-case). Defaults to the panel's composed name.",
    )
    .option("--latest", "Promote the most recently active session instead of naming one")
    .action(
      async (sessionArg: string | undefined, nameArg: string | undefined, opts: SaveOptions) => {
        // With --latest the session is auto-resolved, so a lone positional
        // is interpreted as the NEW panel name (`save --latest mypanel`).
        let sessionSelector = sessionArg;
        let panelNameArg = nameArg;
        if (opts.latest === true && panelNameArg === undefined) {
          panelNameArg = sessionArg;
          sessionSelector = undefined;
        }

        await withPanelContext(async (ctx) => {
          const sessionName = await resolveSession({
            db: ctx.db,
            dataHome: ctx.dataHome,
            panelArg: sessionSelector,
            latest: opts.latest === true,
            writeError,
            missingPanelMessage:
              "Session name is required. Pass `council panel save <session> [name]` or use --latest.",
          });

          const session = await ctx.runtimePanelRepo.findByName(sessionName);
          if (!session) {
            writeError(`Session "${stripControlChars(sessionName)}" not found.\n`);
            throw new CliUserError(`panel save: session "${sessionName}" not found.`);
          }

          const stored = parseStoredDefinition(session.configJson);
          if (stored.kind === "absent") {
            writeError(
              `Session "${stripControlChars(sessionName)}" has no stored panel definition, so it cannot be saved ` +
                `as a library panel. Only sessions created by newer versions of ` +
                `\`council convene\` carry the data needed to promote them (older sessions predate ` +
                `this feature).\n`,
            );
            throw new CliUserError(
              `panel save: session "${sessionName}" has no stored panel definition.`,
            );
          }
          if (stored.kind === "invalid") {
            writeError(
              `Session "${stripControlChars(sessionName)}" has a stored panel definition that is invalid or ` +
                `corrupt and cannot be promoted: ${stored.message}\n`,
            );
            throw new CliUserError(
              `panel save: session "${sessionName}" has an invalid stored panel definition.`,
            );
          }
          const definition = stored.definition;

          // Resolve the requested library name (default: the composed name).
          const requestedName =
            panelNameArg !== undefined && panelNameArg.length > 0
              ? panelNameArg
              : slugifyPanelName(definition.name);
          if (!PANEL_NAME_RE.test(requestedName)) {
            writeError(
              `Invalid panel name "${stripControlChars(requestedName)}": must be kebab-case (lowercase letters, ` +
                `digits, hyphens; must start with a letter).\n`,
            );
            throw new CliUserError(`panel save: invalid panel name "${requestedName}".`);
          }

          const finalPanelName = await assignFreePanelName(ctx, requestedName);

          // Create library experts, suffixing slugs that already exist.
          // Track the slugs created during THIS operation so a partial
          // failure (a later create, or the panel persist, throwing after
          // ≥1 expert was created) can be compensated by deleting exactly
          // those experts — leaving pre-existing library data untouched and
          // preventing orphaned experts (and -2/-3 duplicate accrual on retry).
          const claimedSlugs = new Set<string>();
          const memberSlugs: string[] = [];
          const expertRenames: { readonly from: string; readonly to: string }[] = [];
          const createdSlugs: string[] = [];
          try {
            for (const expert of definition.experts) {
              const finalSlug = await assignFreeExpertSlug(ctx, expert.slug, claimedSlugs);
              claimedSlugs.add(finalSlug);
              if (finalSlug !== expert.slug) {
                expertRenames.push({ from: expert.slug, to: finalSlug });
              }
              await ctx.library.create(allowlistExpertDefinition(expert, finalSlug));
              createdSlugs.push(finalSlug);
              memberSlugs.push(finalSlug);
            }

            // Build + persist the library panel referencing the new slugs,
            // reusing the exact `panel create` write path.
            const defaults: { mode: DebateMode; maxRounds?: number; model?: string } = {
              mode: definition.defaults?.mode ?? "freeform",
            };
            if (definition.defaults?.maxRounds !== undefined) {
              defaults.maxRounds = definition.defaults.maxRounds;
            }
            if (definition.defaults?.model !== undefined) {
              defaults.model = definition.defaults.model;
            }

            const panel: PanelDefinition = PanelDefinitionSchema.parse({
              name: finalPanelName,
              ...(definition.description ? { description: definition.description } : {}),
              defaults,
              experts: memberSlugs,
            });

            const { yamlPath } = await persistPanelArtifacts(ctx, panel, writeError);

            write(
              `✓ Saved session "${stripControlChars(sessionName)}" as panel "${stripControlChars(
                finalPanelName,
              )}" at ${displayPath(yamlPath)}\n`,
            );
            write(`  Experts: ${memberSlugs.join(", ")}\n`);
            if (finalPanelName !== requestedName) {
              write(
                `  Note: a panel named "${stripControlChars(
                  requestedName,
                )}" already existed; saved as "${stripControlChars(finalPanelName)}".\n`,
              );
            }
            for (const rename of expertRenames) {
              write(
                `  Note: expert slug "${rename.from}" already existed; saved as "${rename.to}".\n`,
              );
            }
            write(
              `\nStart a fresh debate with this panel: council chat ${stripControlChars(
                finalPanelName,
              )}\n`,
            );
          } catch (err) {
            // Compensating rollback: delete ONLY the experts this operation
            // created, mirroring the rollback + AggregateError pattern in
            // persistPanelArtifacts. Surface the original error after cleanup
            // so the caller still sees the root cause. Pre-existing library
            // data is never touched (we remove exactly what we added).
            const rollbackErrors: unknown[] = [];
            for (const slug of createdSlugs) {
              try {
                await ctx.library.delete(slug, { force: true });
              } catch (deleteErr) {
                rollbackErrors.push(deleteErr);
              }
            }
            if (rollbackErrors.length > 0) {
              throw new AggregateError(
                [err, ...rollbackErrors],
                `Failed to save panel "${finalPanelName}" and rollback of newly created experts ` +
                  `also failed — library may be inconsistent`,
              );
            }
            throw err;
          }
        });
      },
    );
  return cmd;
}

interface GatheredCreate {
  readonly expertSlugs: readonly string[];
  readonly mode: DebateMode;
  readonly maxRounds: number | undefined;
  readonly description: string | undefined;
}

async function gatherCreateFields(
  opts: CreateOptions,
  library: ExpertLibrary,
  write: Writer,
  writeError: Writer,
): Promise<GatheredCreate> {
  if (opts.experts !== undefined) {
    const expertSlugs = parseExpertList(opts.experts);
    await assertExpertsExist(expertSlugs, library, writeError);
    const mode = parseMode(opts.mode);
    const maxRounds = parseMaxRounds(opts.maxRounds);
    return {
      expertSlugs,
      mode,
      maxRounds,
      description: opts.description,
    };
  }

  // Interactive wizard — list available experts then prompt for selection.
  const available = await library.list();
  if (available.length === 0) {
    throw new Error(
      'No experts found in the library. Create one first with "council expert create", or use "council convene "<topic>"" to auto-compose a panel.',
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    write("Creating a new panel. Press Ctrl+C to abort.\n\n");
    write("Available experts:\n");
    available.forEach((e, i) => {
      write(`  ${i + 1}. ${e.slug} — ${e.displayName} (${e.role})\n`);
    });
    write("\n");

    const selection = (
      await rl.question("Select experts (comma-separated slugs or numbers): ")
    ).trim();
    const expertSlugs = resolveSelection(selection, available);
    if (expertSlugs.length === 0) {
      throw new Error("At least one expert is required");
    }

    const modeRaw = (
      await rl.question(`Mode [${DEBATE_MODES.join("/")}] (default freeform): `)
    ).trim();
    const mode = parseMode(modeRaw.length > 0 ? modeRaw : undefined);

    const maxRoundsRaw = (await rl.question("Max rounds (default unset): ")).trim();
    const maxRounds = parseMaxRounds(maxRoundsRaw.length > 0 ? maxRoundsRaw : undefined);

    const description = (await rl.question("Description (optional): ")).trim();

    return {
      expertSlugs,
      mode,
      maxRounds,
      description: description.length > 0 ? description : opts.description,
    };
  } finally {
    rl.close();
  }
}

function parseExpertList(raw: string | readonly string[]): readonly string[] {
  const slugs = parseExpertSlugs(raw);
  if (slugs.length === 0) {
    throw new Error("At least one expert slug is required (use --experts <slug1>,<slug2>)");
  }
  return slugs;
}

async function assertExpertsExist(
  slugs: readonly string[],
  library: ExpertLibrary,
  writeError?: Writer,
): Promise<void> {
  const missing: string[] = [];
  for (const slug of slugs) {
    const expert = await library.get(slug);
    if (!expert) missing.push(slug);
  }
  if (missing.length > 0) {
    const msg = `Unknown expert slug${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Create with "council expert create" or pick from "council expert list".`;
    if (writeError) writeError(msg + "\n");
    throw new CliUserError(msg);
  }
}

function parseMode(raw: string | undefined): DebateMode {
  if (raw === undefined) return "freeform";
  if ((DEBATE_MODES as readonly string[]).includes(raw)) return raw as DebateMode;
  throw new Error(`Unknown mode "${raw}". Expected one of: ${DEBATE_MODES.join(", ")}`);
}

function parseMaxRounds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new Error(`Invalid --max-rounds value "${raw}": must be an integer between 1 and 20`);
  }
  return n;
}

function resolveSelection(raw: string, available: readonly ExpertDefinition[]): readonly string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const slugs: string[] = [];
  for (const part of parts) {
    const asIndex = Number(part);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= available.length) {
      const expert = available[asIndex - 1];
      if (expert) slugs.push(expert.slug);
    } else {
      slugs.push(part);
    }
  }
  return slugs;
}

// ──────────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────────

async function runPanelList(
  write: Writer,
  format: "table" | "json",
  useLong: boolean,
): Promise<void> {
  await withPanelContext(async (ctx) => {
    const panels = await ctx.panelRepo.findAll();

    if (format === "json") {
      const enriched = await Promise.all(
        panels.map(async (p) => ({
          ...p,
          experts: await ctx.panelRepo.getMembers(p.name),
        })),
      );
      write(JSON.stringify(enriched, null, 2) + "\n");
      return;
    }

    if (panels.length === 0) {
      write('No panels found. Create one with "council panel create <name>".\n');
      return;
    }

    const rows: readonly (readonly string[])[] = await Promise.all(
      panels.map(async (p) => {
        const members = await ctx.panelRepo.getMembers(p.name);
        const desc = p.description ?? "";
        const displayed = useLong ? desc : desc.length > 60 ? desc.slice(0, 57) + "..." : desc;
        return [p.name, String(members.length), displayed] as const;
      }),
    );
    const header = ["name", "experts", "description"] as const;
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    );
    const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
    write(header.map((h, i) => pad(h, widths[i] ?? 0)).join("  ") + "\n");
    write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
    for (const row of rows) {
      write(row.map((c, i) => pad(c, widths[i] ?? 0)).join("  ") + "\n");
    }
    write("\x1b[2mNext: council panel inspect <name> | council convene --template <name>\x1b[0m\n");
  });
}

function buildListCommand(write: Writer): Command {
  const cmd = new Command("list");
  cmd
    .description("List user panels in the library")
    .option("--format <kind>", "Output format: table (default) or json", "table")
    .option("--long", "Show full descriptions without truncation")
    .action(async (raw: { format?: string; long?: boolean }) => {
      if (raw.format !== undefined && raw.format !== "table" && raw.format !== "json") {
        throw new Error(`Unknown --format value: ${raw.format}. Expected one of: table, json`);
      }
      await runPanelList(write, raw.format === "json" ? "json" : "table", raw.long === true);
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
    .option("--format <kind>", "Output format (plain or json)", "plain")
    .action(async (name: string, opts: { format?: string }) => {
      if (opts.format !== "plain" && opts.format !== "json") {
        throw new CliUserError(`Unknown format "${opts.format}" — use "plain" or "json"`);
      }
      await withPanelContext(async (ctx) => {
        const row = await ctx.panelRepo.findByName(name);
        if (!row) {
          const allPanels = (await ctx.panelRepo.findAll()).map((p) => p.name);
          const msg = formatPanelNotFound(name, allPanels);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        const memberSlugs = await ctx.panelRepo.getMembers(name);

        // Load YAML for defaults (mode, maxRounds) so inspect reflects on-disk state.
        let defaults:
          | {
              mode?: string | undefined;
              maxRounds?: number | undefined;
              model?: string | undefined;
            }
          | undefined;
        try {
          const onDisk = await fs.readFile(row.yamlPath, "utf-8");
          const parsed = PanelDefinitionSchema.parse(yaml.parse(onDisk));
          defaults = parsed.defaults;
        } catch {
          /* tolerate missing/invalid file at inspect time */
        }

        if (opts.format === "json") {
          const members: { slug: string; displayName?: string; role?: string; kind?: string }[] =
            [];
          for (const slug of memberSlugs) {
            const expert = await ctx.library.get(slug);
            if (expert) {
              members.push({
                slug,
                displayName: expert.displayName,
                role: expert.role,
                kind: expert.kind,
              });
            } else {
              members.push({ slug });
            }
          }
          const json = {
            name: row.name,
            file: displayPath(row.yamlPath),
            ...(row.description ? { description: row.description } : {}),
            ...(defaults ? { defaults } : {}),
            members,
          };
          write(JSON.stringify(json, null, 2) + "\n");
          return;
        }

        write(`Panel: ${row.name}\n`);
        write(`File:  ${displayPath(row.yamlPath)}\n`);
        if (row.description) {
          write(`Description: ${row.description}\n`);
        }
        write("\n");

        if (defaults) {
          if (defaults.mode) write(`Mode:       ${defaults.mode}\n`);
          if (defaults.maxRounds !== undefined) write(`Max Rounds: ${defaults.maxRounds}\n`);
          if (defaults.model) write(`Model:      ${defaults.model}\n`);
          write("\n");
        }

        write(`Members (${memberSlugs.length}):\n`);
        for (const slug of memberSlugs) {
          const expert = await ctx.library.get(slug);
          if (expert) {
            write(`  - ${slug}: ${expert.displayName} — ${expert.role} [${expert.kind}]\n`);
          } else {
            write(`  - ${slug}: (missing from expert library)\n`);
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
        const existing = await ctx.panelRepo.findByName(name);
        if (!existing) {
          const allPanels = (await ctx.panelRepo.findAll()).map((p) => p.name);
          const msg = formatPanelNotFound(name, allPanels);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        const yamlPath = existing.yamlPath;
        const editor = resolveEditor();

        // DX-07: Create backup before editing (reject symlinks / path escape)
        const backupPath = yamlPath + ".backup";
        const realYamlPath = await fs.realpath(yamlPath);
        const panelsDir = await fs.realpath(path.resolve(ctx.dataHome, "panels"));
        const rel = path.relative(panelsDir, realYamlPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new CliUserError("Cannot edit panel file outside managed directory");
        }
        // Reject pre-existing backup symlinks to prevent write redirection
        try {
          const bstat = await fs.lstat(backupPath);
          if (bstat.isSymbolicLink()) {
            throw new CliUserError("Backup path is a symlink — remove it before editing");
          }
        } catch (e: unknown) {
          if (e instanceof CliUserError) throw e;
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw e;
        }
        await fs.copyFile(realYamlPath, backupPath);

        await runEditor(editor, yamlPath);

        // Re-read and validate. Keep the bytes so checksum below describes
        // exactly the content we validated (closes a TOCTOU race vs. a
        // second readFile() at write time).
        let onDisk: string;
        let parsed: PanelDefinition;
        try {
          onDisk = await fs.readFile(yamlPath, "utf-8");
          parsed = PanelDefinitionSchema.parse(yaml.parse(onDisk));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(`Invalid panel YAML after edit: ${message}\n`);
          writeError(`Backup saved at: ${backupPath}\n`);
          throw err;
        }

        if (parsed.name !== name) {
          writeError(
            `Refusing to rename panel "${name}" → "${parsed.name}" via edit. Delete and re-create to change the name.\n`,
          );
          throw new CliUserError(
            `Panel rename via edit is not supported (was "${name}", became "${parsed.name}")`,
          );
        }

        // FK validation: every slug reference must exist in the expert library.
        const slugRefs = parsed.experts.map(entrySlug);
        await assertExpertsExist(slugRefs, ctx.library, writeError);

        const checksum = sha256(onDisk);
        await ctx.panelRepo.update(name, {
          description: parsed.description ?? null,
          yamlPath,
          yamlChecksum: checksum,
        });
        await ctx.panelRepo.setMembers(name, slugRefs);

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

// ──────────────────────────────────────────────────────────────────────
// docs (Roadmap 6.7)
// ──────────────────────────────────────────────────────────────────────

interface DocsLinkOptions {
  readonly path?: string;
  readonly yes?: boolean;
}

function buildDocsCommand(
  write: Writer,
  writeError: Writer,
  confirmProvider?: ConfirmProvider,
): Command {
  const cmd = new Command("docs");
  cmd.description("Manage panel reference documents (list, link, unlink)");
  cmd.addCommand(buildDocsListCommand(write, writeError));
  cmd.addCommand(buildDocsLinkCommand(write, writeError, confirmProvider));
  cmd.addCommand(buildDocsUnlinkCommand(write, writeError));
  // Allow `council panel docs <name>` to fall through to the list action
  // without forcing users to type `docs list`. Commander treats the
  // default argument as the panel name.
  cmd
    .argument("[name]", "Panel name (when omitted, prints usage)")
    .action(async (name: string | undefined) => {
      if (name === undefined) {
        write(cmd.helpInformation());
        return;
      }
      await runDocsList(name, write, writeError);
    });
  return cmd;
}

function buildDocsListCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("list");
  cmd
    .description("List all documents accessible to a panel (managed + linked)")
    .argument("<name>", "Panel name")
    .action(async (name: string) => {
      await runDocsList(name, write, writeError);
    });
  return cmd;
}

async function runDocsList(name: string, write: Writer, writeError: Writer): Promise<void> {
  await withPanelContext(async (ctx) => {
    const panel = await ctx.panelRepo.findByName(name);
    if (!panel) {
      writeError(`Panel "${name}" not found.\n`);
      throw new CliUserError(`Panel "${name}" not found.`);
    }

    // Trigger indexing before listing so freshly-dropped files appear
    // (fixes #14 — lazy indexing was misleading). This makes `list`
    // consistent with other docs commands that show current disk state.
    const managedDocsDir = panelDocsDir(ctx.dataHome, name);
    await scanAndIndexPanelDocuments({
      panelName: name,
      managedDocsDir,
      db: ctx.db,
      supportedFormats: ctx.config.expert.supportedFormats,
      maxFileSizeBytes: ctx.config.documents.maxFileSizeMB * 1024 * 1024,
      aiFallback: {
        mode: ctx.config.documents.aiExtraction,
        allowedExtensions: ctx.config.documents.aiExtractionAllowedExtensions,
      },
    });

    const docs = await ctx.docsRepo.listDocuments(name);
    const folders = await ctx.docsRepo.getLinkedFolders(name);

    if (docs.length === 0 && folders.length === 0) {
      const docsDir = panelDocsDir(ctx.dataHome, name);
      write(
        `No documents found for panel "${name}". Drop files into ${displayPath(docsDir)} or run "council panel docs link ${name} --path <dir>".\n`,
      );
      return;
    }

    if (folders.length > 0) {
      write(`Linked folders (${folders.length}):\n`);
      for (const folder of folders) write(`  - ${displayPath(folder)}\n`);
      write("\n");
    }

    if (docs.length === 0) {
      write("No documents indexed yet.\n");
      return;
    }

    const rows = docs.map((d: PanelDocument) => [
      d.source,
      displayPath(d.filePath),
      d.filename,
      String(d.wordCount),
      d.processedAt ?? d.createdAt,
    ]);
    const header = ["source", "path", "filename", "words", "indexed"] as const;
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
}

function buildDocsLinkCommand(
  write: Writer,
  writeError: Writer,
  confirmProvider?: ConfirmProvider,
): Command {
  const cmd = new Command("link");
  cmd
    .description("Link an external folder for RAG retrieval")
    .argument("<name>", "Panel name")
    .requiredOption("--path <path>", "Absolute path to the folder to link")
    .option("--yes", "Skip the confirmation prompt (non-interactive runs)")
    .action(async (name: string, opts: DocsLinkOptions) => {
      const folderPath = opts.path;
      if (folderPath === undefined || folderPath.trim().length === 0) {
        writeError("--path is required\n");
        throw new CliUserError("--path is required");
      }
      const absolute = path.resolve(folderPath);

      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          writeError(`Path does not exist: ${displayPath(absolute)}\n`);
          throw new CliUserError(`Path does not exist: ${absolute}`);
        }
        throw err;
      }
      if (stat.isSymbolicLink()) {
        // The scanner refuses to follow a symlinked folder root for
        // confinement safety (panel-document-scanner.ts). Reject here
        // too so the user gets a clear error at link-time rather than
        // a silent "0 documents indexed" later. (issue #390)
        writeError(
          `Path is a symlink: ${displayPath(absolute)} — pass the real folder path instead.\n`,
        );
        throw new CliUserError(`Path is a symlink: ${absolute}`);
      }
      if (!stat.isDirectory()) {
        writeError(`Path is not a directory: ${displayPath(absolute)}\n`);
        throw new CliUserError(`Path is not a directory: ${absolute}`);
      }

      // Confirmation gate — granting panel read access to an external
      // folder should be an explicit user decision (PRD F7, issue #472).
      if (opts.yes !== true) {
        const provider = confirmProvider ?? createReadlineConfirmProvider();
        const ok = await provider.confirm(
          `Grant panel "${name}" read access to ${displayPath(absolute)}? [y/N] `,
        );
        if (!ok) {
          writeError(`Aborted: declined to link ${displayPath(absolute)}.\n`);
          throw new Error(`Aborted: declined to link ${absolute}`);
        }
      }

      await withPanelContext(async (ctx) => {
        const panel = await ctx.panelRepo.findByName(name);
        if (!panel) {
          writeError(`Panel "${name}" not found.\n`);
          throw new CliUserError(`Panel "${name}" not found.`);
        }
        await ctx.docsRepo.addLinkedFolder(name, absolute);
        const supported = new Set(
          ctx.config.expert.supportedFormats.map((e) =>
            e.toLowerCase().startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
          ),
        );
        const count = await countSupportedFiles(absolute, supported);
        write(`✓ Linked ${displayPath(absolute)} to ${name}. ${count} documents found.\n`);
      });
    });
  return cmd;
}

function buildDocsUnlinkCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("unlink");
  cmd
    .description("Remove a linked folder and un-index its documents")
    .argument("<name>", "Panel name")
    .requiredOption("--path <path>", "Folder path previously linked")
    .action(async (name: string, opts: DocsLinkOptions) => {
      const folderPath = opts.path;
      if (folderPath === undefined || folderPath.trim().length === 0) {
        writeError("--path is required\n");
        throw new CliUserError("--path is required");
      }
      const absolute = path.resolve(folderPath);

      await withPanelContext(async (ctx) => {
        const panel = await ctx.panelRepo.findByName(name);
        if (!panel) {
          writeError(`Panel "${name}" not found.\n`);
          throw new CliUserError(`Panel "${name}" not found.`);
        }
        // #388: All FTS removes + metadata deletes must be a single
        // atomic unit. Removing FTS rows one at a time without a
        // surrounding transaction means a mid-loop failure leaves
        // already-removed entries gone, while the panel-doc scanner
        // skips unchanged files (it only re-indexes new/modified ones).
        // Stale-by-omission docs would silently disappear from
        // retrieval. We wrap the whole sequence in BEGIN/COMMIT/ROLLBACK
        // on the libsql client so any failure restores both the FTS
        // index and the metadata to their pre-unlink state.
        const { createDocumentIndexer } = await import("../../core/documents/indexer.js");
        const { sql } = await import("kysely");
        const indexer = createDocumentIndexer(ctx.db);
        const docs = await ctx.docsRepo.listDocuments(name);
        await sql`BEGIN`.execute(ctx.db);
        try {
          for (const d of docs) {
            if (
              d.filePath === absolute ||
              d.filePath.startsWith(absolute + path.sep) ||
              d.filePath.startsWith(absolute + "/") ||
              d.filePath.startsWith(absolute + "\\")
            ) {
              await indexer.remove(d.filePath);
            }
          }
          await ctx.docsRepo.removeDocumentsUnderFolder(name, absolute);
          await ctx.docsRepo.removeLinkedFolder(name, absolute);
          await sql`COMMIT`.execute(ctx.db);
        } catch (err: unknown) {
          try {
            await sql`ROLLBACK`.execute(ctx.db);
          } catch {
            /* swallow rollback errors so the original failure is preserved */
          }
          const detail = err instanceof Error ? err.message : String(err);
          const msg =
            `Unlink aborted for ${displayPath(absolute)}: failed to clean up FTS ` +
            `index and/or metadata (${detail}). Linked folder preserved; re-run ` +
            `unlink after addressing the error.`;
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }
        write(`✓ Unlinked ${displayPath(absolute)} from ${name}.\n`);
        write("\x1b[2mRun 'council panel list' to verify.\x1b[0m\n");
      });
    });
  return cmd;
}

async function countSupportedFiles(
  dir: string,
  supportedExts: ReadonlySet<string>,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const rel of entries) {
    const absolute = path.resolve(dir, rel);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    if (supportedExts.has(path.extname(absolute).toLowerCase())) count += 1;
  }
  return count;
}

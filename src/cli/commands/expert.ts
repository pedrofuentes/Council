/**
 * `council expert create|list|inspect|edit|delete` (Roadmap 4.3)
 *
 * Thin Commander wrapper over `FileExpertLibrary`. Interactive prompts
 * use `node:readline/promises`; every required field also has a flag so
 * the command is testable in non-TTY environments.
 *
 * The subcommands share a single helper that opens the Council DB +
 * library, runs the operation, and tears the DB down on exit.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Command, Option } from "commander";

import { CliUserError } from "../cli-user-error.js";

import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  type CouncilConfig,
} from "../../config/index.js";
import { createDocumentIndexer } from "../../core/documents/indexer.js";
import { createDocumentProcessor } from "../../core/documents/processor.js";
import { FileExpertLibrary, type ExpertLibrary } from "../../core/expert-library.js";
import { ExpertDefinitionSchema, type ExpertDefinition } from "../../core/expert.js";
import type { CouncilEngine } from "../../engine/index.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import {
  ClearForRetrainError,
  DocumentRepository,
} from "../../memory/repositories/document-repository.js";
import { ProfileRepository } from "../../memory/repositories/profile-repository.js";
import { ENGINE_KINDS, type EngineKind, makeEngineFromKind } from "../run-with-engine.js";
import { suggestMatch } from "../fuzzy-match.js";
import { isNonInteractive } from "../non-interactive.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function formatNotFound(kind: string, slug: string, available: readonly string[]): string {
  const suggestions = suggestMatch(slug, available);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  return `${kind} "${slug}" not found.${hint}`;
}

export interface ExpertCommandDeps {
  /** Test-only override for the CouncilEngine used by `expert train`. */
  readonly engineFactory?: () => CouncilEngine;
}

async function withExpertLibrary<T>(
  fn: (
    library: ExpertLibrary,
    config: CouncilConfig,
    dataHome: string,
    db: CouncilDatabase,
  ) => Promise<T>,
): Promise<T> {
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);
  const library = new FileExpertLibrary(dataHome, db);
  try {
    return await fn(library, config, dataHome, db);
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

export function buildExpertCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
  deps: ExpertCommandDeps = {},
): Command {
  const cmd = new Command("expert");
  cmd.description("Manage Council's expert library (create, list, inspect, edit, delete)");
  cmd.addCommand(buildCreateCommand(write, writeError));
  cmd.addCommand(buildListCommand(write));
  cmd.addCommand(buildInspectCommand(write, writeError));
  cmd.addCommand(buildEditCommand(write, writeError));
  cmd.addCommand(buildDeleteCommand(write, writeError));
  cmd.addCommand(buildDocsCommand(write, writeError));
  cmd.addCommand(buildTrainCommand(write, writeError, deps));

  cmd.addHelpText(
    "after",
    `
Examples:
  $ council expert create                           # interactive wizard
  $ council expert list                             # browse your library
  $ council expert inspect security-auditor         # full detail
`,
  );

  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────────

interface CreateOptions {
  readonly persona?: boolean;
  readonly slug?: string;
  readonly name?: string;
  readonly role?: string;
  readonly expertise?: string;
  readonly stance?: string;
  readonly model?: string;
  readonly personality?: string;
  readonly personaDescription?: string;
}

function buildCreateCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("create");
  cmd
    .description("Create a new expert in the library")
    .option("--persona", "Create a persona expert (real person)")
    .option("--slug <slug>", "URL-safe slug (lowercase, alphanumeric + hyphens)")
    .option("--name <displayName>", "Display name")
    .option("--role <role>", "One-line role descriptor")
    .option("--expertise <items>", "Comma-separated weighted-evidence types (at least one)")
    .option("--stance <stance>", "Epistemic stance")
    .option("--model <model>", "Model identifier (e.g. claude-haiku-4.5)")
    .option("--personality <flavor>", "Optional personality flavor")
    .option("--persona-description <text>", "Persona relationship description")
    .action(async (opts: CreateOptions) => {
      const fields = await gatherCreateFields(opts, write);
      validateSlug(fields.slug);

      const weightedEvidence = fields.expertise
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (weightedEvidence.length === 0) {
        throw new Error("At least one expertise / weighted-evidence entry is required");
      }

      const definition: ExpertDefinition = ExpertDefinitionSchema.parse({
        slug: fields.slug,
        displayName: fields.name,
        role: fields.role,
        expertise: {
          weightedEvidence,
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: fields.stance,
        ...(opts.model ? { model: opts.model } : {}),
        ...(fields.personality ? { personality: fields.personality } : {}),
        kind: opts.persona ? "persona" : "generic",
        ...(opts.persona && fields.personaDescription
          ? { personaDescription: fields.personaDescription }
          : {}),
      });

      await withExpertLibrary(async (library, _config, dataHome) => {
        const existing = await library.get(definition.slug);
        if (existing) {
          writeError(
            `Expert "${definition.slug}" already exists. Use "council expert edit ${definition.slug}" to modify or choose a different slug.\n`,
          );
          throw new CliUserError(`Expert "${definition.slug}" already exists`);
        }

        await library.create(definition);

        const yamlPath = path.join(dataHome, "experts", `${definition.slug}.yaml`);
        write(`✓ Expert "${definition.slug}" created at ${displayPath(yamlPath)}\n`);

        if (opts.persona) {
          const docsDir = path.join(dataHome, "experts", definition.slug, "docs");
          await fs.mkdir(docsDir, { recursive: true });
          write(`  Place documents about this person in ${displayPath(docsDir)}\n`);
        }
      });
    });
  return cmd;
}

interface GatheredFields {
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly expertise: string;
  readonly stance: string;
  readonly personality?: string;
  readonly personaDescription?: string;
}

async function gatherCreateFields(opts: CreateOptions, write: Writer): Promise<GatheredFields> {
  // If every required field was provided via flags, skip the interactive
  // wizard entirely — this is the path tests exercise.
  if (
    opts.slug !== undefined &&
    opts.name !== undefined &&
    opts.role !== undefined &&
    opts.expertise !== undefined &&
    opts.stance !== undefined &&
    (!opts.persona || opts.personaDescription !== undefined)
  ) {
    return {
      slug: opts.slug,
      name: opts.name,
      role: opts.role,
      expertise: opts.expertise,
      stance: opts.stance,
      ...(opts.personality !== undefined ? { personality: opts.personality } : {}),
      ...(opts.personaDescription !== undefined
        ? { personaDescription: opts.personaDescription }
        : {}),
    };
  }

  // Interactive wizard. Only prompts for fields not provided as flags.
  const rl = readline.createInterface({ input, output });
  try {
    const promptFor = async (
      label: string,
      preset: string | undefined,
      required: boolean,
    ): Promise<string> => {
      if (preset !== undefined) return preset;
      while (true) {
        const value = (await rl.question(`${label}: `)).trim();
        if (value.length > 0) return value;
        if (!required) return "";
        write("Value is required.\n");
      }
    };

    write("Creating a new expert. Press Ctrl+C to abort.\n\n");
    const slug = await promptFor("slug (lowercase alphanumeric + hyphens)", opts.slug, true);
    const name = await promptFor('displayName (e.g. "Dahlia Renner (CTO)")', opts.name, true);
    const role = await promptFor("role (one-line)", opts.role, true);
    const expertise = await promptFor(
      "expertise / weighted evidence (comma-separated)",
      opts.expertise,
      true,
    );
    const stance = await promptFor("epistemic stance", opts.stance, true);
    const personality = await promptFor(
      "personality (optional, blank to skip)",
      opts.personality,
      false,
    );
    let personaDescription: string | undefined;
    if (opts.persona) {
      personaDescription = await promptFor(
        "personaDescription (relationship)",
        opts.personaDescription,
        true,
      );
    }
    return {
      slug,
      name,
      role,
      expertise,
      stance,
      ...(personality ? { personality } : {}),
      ...(personaDescription ? { personaDescription } : {}),
    };
  } finally {
    rl.close();
  }
}

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}": must be lowercase alphanumeric and hyphens only, 1-64 chars`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────────

function buildListCommand(write: Writer): Command {
  const cmd = new Command("list");
  cmd
    .description("List all experts in the library")
    .option("--format <kind>", "Output format: table (default) or json", "table")
    .action(async (raw: { format?: string }) => {
      if (raw.format !== undefined && raw.format !== "table" && raw.format !== "json") {
        throw new Error(`Unknown --format value: ${raw.format}. Expected one of: table, json`);
      }
      const format: "table" | "json" = raw.format === "json" ? "json" : "table";

      await withExpertLibrary(async (library) => {
        const experts = await library.list();

        if (format === "json") {
          const enriched = await Promise.all(
            experts.map(async (e) => ({
              ...e,
              panels: await library.panelsFor(e.slug),
            })),
          );
          write(JSON.stringify(enriched, null, 2) + "\n");
          return;
        }

        if (experts.length === 0) {
          write('No experts found. Create one with "council expert create".\n');
          return;
        }

        const rows: readonly (readonly string[])[] = await Promise.all(
          experts.map(async (e) => {
            const panels = await library.panelsFor(e.slug);
            return [e.slug, e.displayName, e.role, e.kind, String(panels.length)] as const;
          }),
        );
        const header = ["slug", "display name", "role", "kind", "panels"] as const;
        const widths = header.map((h, i) =>
          Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
        );
        const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
        write(header.map((h, i) => pad(h, widths[i] ?? 0)).join("  ") + "\n");
        write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
        for (const row of rows) {
          write(row.map((c, i) => pad(c, widths[i] ?? 0)).join("  ") + "\n");
        }
        write("\x1b[2mNext: council expert inspect <slug> | council chat <slug>\x1b[0m\n");
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
    .description("Show full detail for a single expert")
    .argument("<slug>", "Expert slug to inspect")
    .action(async (slug: string) => {
      await withExpertLibrary(async (library, _config, dataHome) => {
        const expert = await library.get(slug);
        if (!expert) {
          const all = (await library.list()).map((e) => e.slug);
          const msg = formatNotFound("Expert", slug, all);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        const panels = await library.panelsFor(slug);
        const yamlPath = path.join(dataHome, "experts", `${slug}.yaml`);

        write(`Expert: ${expert.slug}\n`);
        write(`Name:   ${expert.displayName}\n`);
        write(`Role:   ${expert.role}\n`);
        write(`Kind:   ${expert.kind}\n`);
        if (expert.model) {
          write(`Model:  ${expert.model}\n`);
        }
        write(`File:   ${displayPath(yamlPath)}\n`);
        write("\n");
        if (panels.length === 0) {
          write("Panels: (none)\n");
        } else {
          write(`Panels: ${panels.join(", ")}\n`);
        }
        write("\n");
        write("Expertise:\n");
        write(`  Weighted Evidence: ${expert.expertise.weightedEvidence.join(", ")}\n`);
        if (expert.expertise.referenceCases.length > 0) {
          write(`  Reference Cases:   ${expert.expertise.referenceCases.join(", ")}\n`);
        }
        if (expert.expertise.notExpertIn.length > 0) {
          write(`  Not Expert In:     ${expert.expertise.notExpertIn.join(", ")}\n`);
        }
        write("\n");
        write(`Epistemic Stance: ${expert.epistemicStance}\n`);
        if (expert.personality) {
          write(`Personality:      ${expert.personality}\n`);
        }
        if (expert.kind === "persona" && expert.personaDescription) {
          write(`Persona:          ${expert.personaDescription}\n`);
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
    .description("Open the expert YAML in $EDITOR and re-validate on save")
    .argument("<slug>", "Expert slug to edit")
    .action(async (slug: string) => {
      await withExpertLibrary(async (library, _config, dataHome) => {
        const existing = await library.get(slug);
        if (!existing) {
          const all = (await library.list()).map((e) => e.slug);
          const msg = formatNotFound("Expert", slug, all);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        const yamlPath = path.join(dataHome, "experts", `${slug}.yaml`);
        const editor = resolveEditor();

        await runEditor(editor, yamlPath);

        // Re-read and validate the edited file. We do this directly rather
        // than via library.get() because the library reads the YAML path
        // recorded in the DB metadata row — we need to parse what is on
        // disk to detect slug renames and to refresh the DB checksum.
        let parsed: ExpertDefinition;
        try {
          const yamlMod = await import("yaml");
          const onDisk = await fs.readFile(yamlPath, "utf-8");
          parsed = ExpertDefinitionSchema.parse(yamlMod.parse(onDisk));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(`Validation failed after edit: ${message}\n`);
          throw err;
        }

        if (parsed.slug !== slug) {
          writeError(
            `Refusing to rename slug "${slug}" → "${parsed.slug}" via edit. Delete and re-create the expert to change its slug.\n`,
          );
          throw new CliUserError(
            `Slug rename via edit is not supported (was "${slug}", became "${parsed.slug}")`,
          );
        }

        // Persist the freshly-parsed definition through the library so the
        // expert_library row (kind, displayName, yaml_checksum) catches up
        // with the on-disk YAML.
        await library.update(slug, parsed);
        write(`✓ Expert "${slug}" saved and validated.\n`);
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
  // Split into command + args so users can set EDITOR="code --wait" etc.
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
// delete
// ──────────────────────────────────────────────────────────────────────

function buildDeleteCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("delete");
  cmd
    .description("Delete an expert from the library")
    .argument("<slug>", "Expert slug to delete")
    .option("--force", "Delete even if the expert is a member of one or more panels")
    .option("--yes", "Skip confirmation prompt (required with --force in non-interactive mode)")
    .action(async (slug: string, opts: { force?: boolean; yes?: boolean }) => {
      await withExpertLibrary(async (library) => {
        const existing = await library.get(slug);
        if (!existing) {
          const all = (await library.list()).map((e) => e.slug);
          const msg = formatNotFound("Expert", slug, all);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        const panels = await library.panelsFor(slug);
        if (panels.length > 0 && !opts.force) {
          const msg = `Expert "${slug}" is used in ${panels.length} panel${panels.length === 1 ? "" : "s"}: ${panels.join(", ")}\nUse --force to delete anyway.`;
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }
        if (panels.length > 0 && opts.force && !opts.yes && isNonInteractive()) {
          const msg = `Non-interactive mode: --force requires --yes to confirm deletion of "${slug}" (used in ${panels.length} panel${panels.length === 1 ? "" : "s"}).`;
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }
        await library.delete(slug, { force: opts.force === true });
        write(`✓ Expert "${slug}" deleted.\n`);
        write("\x1b[2mRun 'council expert list' to verify.\x1b[0m\n");
      });
    });
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// docs (Roadmap 6.6)
// ──────────────────────────────────────────────────────────────────────

interface DocsOptions {
  readonly remove?: string;
}

function buildDocsCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("docs");
  cmd
    .description("List or un-index documents for a persona expert")
    .argument("<slug>", "Persona expert slug")
    .option(
      "--remove <file>",
      "Un-index the named document (kept on disk; profile refreshes on next use)",
    )
    .action(async (slug: string, opts: DocsOptions) => {
      await withExpertLibrary(async (library, _config, _dataHome, db) => {
        const expert = await library.get(slug);
        if (!expert) {
          const all = (await library.list()).map((e) => e.slug);
          const msg = formatNotFound("Expert", slug, all);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        if (expert.kind !== "persona") {
          const msg = `Expert "${slug}" is not a persona expert — only persona experts have indexed documents.`;
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }

        const documentRepo = new DocumentRepository(db);
        const indexer = createDocumentIndexer(db);

        if (opts.remove !== undefined) {
          const target = opts.remove;
          const rows = await documentRepo.findByExpert(slug);
          const match = rows.find(
            (r) => r.status !== "removed" && (r.filename === target || r.filePath === target),
          );
          if (!match) {
            const msg = `Document "${target}" not found in the index for "${slug}".`;
            writeError(msg + "\n");
            throw new CliUserError(msg);
          }
          // DB row is the source of truth for "is this document active?".
          // Mark it removed FIRST: if indexer.remove() then fails, the row's
          // 'removed' status causes the next training run to treat the file
          // as new and re-index it (replace-by-path semantics in the
          // indexer), which heals any stale FTS5 entry. Doing it in the
          // opposite order would leave the index empty while the DB still
          // reports the file as active — a state the processor cannot
          // recover from without manual intervention.
          await documentRepo.markRemoved(match.id);
          let ftsCleanupFailed = false;
          try {
            await indexer.remove(match.filePath);
          } catch (err: unknown) {
            ftsCleanupFailed = true;
            const detail = err instanceof Error ? err.message : String(err);
            writeError(
              `Warning: index entry for "${target}" could not be removed (${detail}). ` +
                `It will be replaced on the next training run.\n`,
            );
          }
          // #382: do NOT report ✓ when the FTS5 cleanup failed. The row is
          // marked removed in tracking (the source of truth), but the
          // user must know the index is in a partial state and a future
          // training run is required to heal it.
          if (ftsCleanupFailed) {
            write(
              `⚠ "${target}" removed from tracking but FTS index cleanup failed. ` +
                `Re-run "council expert train ${slug}" to repair the index.\n`,
            );
          } else {
            write(`✓ "${target}" removed from index. Profile will be updated on next use.\n`);
          }
          return;
        }

        const all = await documentRepo.findByExpert(slug);
        const active = all.filter((d) => d.status !== "removed");
        if (active.length === 0) {
          write(`ℹ No documents indexed for "${slug}".\n`);
          return;
        }

        const header = ["filename", "words", "processed", "status"] as const;
        const rows: readonly (readonly string[])[] = active.map((d) => [
          d.filename,
          String(d.wordCount),
          d.processedAt ?? "—",
          d.status,
        ]);
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
// train (Roadmap 6.6)
// ──────────────────────────────────────────────────────────────────────

interface TrainOptions {
  readonly retrain?: boolean;
  readonly engine?: string;
}

function buildTrainCommand(write: Writer, writeError: Writer, deps: ExpertCommandDeps): Command {
  const cmd = new Command("train");
  cmd
    .description("Reprocess all documents for a persona expert and refresh its profile")
    .argument("<slug>", "Persona expert slug")
    .option("--retrain", "Clear the existing profile and rebuild from scratch")
    .addOption(
      new Option("--engine <kind>", "Engine to use for profile analysis")
        .choices([...ENGINE_KINDS])
        .default("copilot"),
    )
    .action(async (slug: string, opts: TrainOptions) => {
      const engineKind = (opts.engine ?? "copilot") as EngineKind;

      await withExpertLibrary(async (library, config, dataHome, db) => {
        const expert = await library.get(slug);
        if (!expert) {
          const all = (await library.list()).map((e) => e.slug);
          const msg = formatNotFound("Expert", slug, all);
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }
        if (expert.kind !== "persona") {
          const msg = `Expert "${slug}" is not a persona expert — only persona experts can be trained.`;
          writeError(msg + "\n");
          throw new CliUserError(msg);
        }

        const docsPath = path.join(dataHome, "experts", slug, "docs");
        await fs.mkdir(docsPath, { recursive: true });

        const documentRepo = new DocumentRepository(db);
        const profileRepo = new ProfileRepository(db);
        const indexer = createDocumentIndexer(db);
        const engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(engineKind);

        // --retrain: drop the profile and mark every existing doc row as
        // removed so the detector reclassifies all files as new and the
        // analyzer is forced to re-run.
        //
        // #383: the FTS index DELETE and the tracking UPDATE must run
        // as a single atomic unit. If FTS rows were deleted but the
        // tracking UPDATE failed, the processor would treat the docs as
        // already-processed and skip them, so retrieval would return
        // nothing until the user forced another retrain. If the tracking
        // UPDATE succeeded but FTS rows were not deleted, stale snippets
        // would surface from "removed" documents. ``clearForRetrain``
        // wraps both in a BEGIN/COMMIT/ROLLBACK on the same libsql
        // connection. On failure the existing profile is also preserved
        // so the user is never left with an empty profile and partially
        // cleared tracking.
        if (opts.retrain === true) {
          const tracked = await documentRepo.findByExpert(slug);
          const activeCount = tracked.filter((r) => r.status !== "removed").length;
          try {
            await documentRepo.clearForRetrain(slug);
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err);
            // Default conservatively: only claim "preserved" when we
            // received a trusted ClearForRetrainError that reports a
            // clean rollback. Any unexpected error type is treated as
            // unknown DB state so the user is never falsely reassured.
            const cleanRollback = err instanceof ClearForRetrainError && !err.rollbackFailed;
            const stateNote = cleanRollback
              ? `Existing profile and tracking preserved.`
              : `Cleanup failed AND rollback either failed or status is unknown — ` +
                `database may be in an inconsistent state for "${slug}" (FTS index ` +
                `and tracked documents may disagree). Inspect the document_index ` +
                `and expert_documents tables before retrying.`;
            const msg =
              `Retrain aborted for "${slug}": failed to clear ${activeCount} ` +
              `tracked document(s) and FTS index entries (${detail}). ` +
              `${stateNote} ` +
              `Re-run "council expert train ${slug} --retrain" after addressing the error above.`;
            writeError(msg + "\n");
            throw new CliUserError(msg);
          }
          await profileRepo.delete(slug);
          write(
            `↻ Retrain: cleared profile and tracking for "${slug}" (${activeCount} cleared).\n`,
          );
        }

        const processor = createDocumentProcessor({
          engine,
          documentRepo,
          profileRepo,
          indexer,
          config: {
            supportedFormats: config.expert.supportedFormats,
            recencyHalfLifeDays: config.expert.recencyHalfLifeDays,
          },
        });

        try {
          await engine.start();
          write(`Training "${slug}" from ${displayPath(docsPath)}...\n`);
          const result = await processor.process(slug, docsPath, (p) => {
            if (p.status === "failed") {
              write(`  ${p.filename}: failed (${p.error ?? "unknown"})\n`);
            } else {
              write(`  ${p.filename}: ${p.wordCount} words\n`);
            }
          });
          write(
            `✓ Processed ${result.filesProcessed} document(s) ` +
              `(${result.filesSkipped} unchanged, ${result.filesFailed} failed, ${result.filesRemoved} removed, ${result.totalWords} total words).\n`,
          );
          if (result.profileError !== null) {
            writeError(`Persona profile refresh failed: ${result.profileError}\n`);
          } else if (result.profileUpdated) {
            write(`✓ Persona profile updated.\n`);
          }
        } finally {
          await engine.stop().catch(() => undefined);
        }
      });
    });
  return cmd;
}

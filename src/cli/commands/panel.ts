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

import { Command } from "commander";

import { CliUserError } from "../cli-user-error.js";
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
  type DebateMode,
  type PanelDefinition,
  type PanelExpertEntry,
} from "../../core/template-loader.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { PanelLibraryRepository } from "../../memory/repositories/panel-library-repo.js";
import {
  PanelDocumentRepository,
  type PanelDocument,
} from "../../memory/repositories/panel-document-repo.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const PANEL_NAME_RE = /^[a-z][a-z0-9-]*$/;

interface PanelContext {
  readonly library: ExpertLibrary;
  readonly panelRepo: PanelLibraryRepository;
  readonly docsRepo: PanelDocumentRepository;
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
  try {
    return await fn({ library, panelRepo, docsRepo, config, dataHome, db });
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

export function buildPanelCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
): Command {
  const cmd = new Command("panel");
  cmd.description("Manage Council panels (create, list, inspect, edit)");
  cmd.addCommand(buildCreateCommand(write, writeError));
  cmd.addCommand(buildListCommand(write));
  cmd.addCommand(buildInspectCommand(write, writeError));
  cmd.addCommand(buildEditCommand(write, writeError));
  cmd.addCommand(buildDocsCommand(write, writeError));
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────────

interface CreateOptions {
  readonly experts?: string;
  readonly mode?: string;
  readonly maxRounds?: string;
  readonly model?: string;
  readonly description?: string;
}

function buildCreateCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("create");
  cmd
    .description("Create a new panel with library experts")
    .argument("<name>", "Panel name (kebab-case)")
    .option("--experts <slugs>", "Comma-separated expert slugs from the library")
    .option("--mode <mode>", `Debate mode: ${DEBATE_MODES.join(" | ")}`)
    .option("--max-rounds <n>", "Maximum debate rounds (1-20)")
    .option("--model <model>", "Default model for all experts in this panel")
    .option("--description <text>", "One-line description")
    .action(async (name: string, opts: CreateOptions) => {
      validatePanelName(name);

      await withPanelContext(async (ctx) => {
        const existingRow = await ctx.panelRepo.findByName(name);
        if (existingRow) {
          writeError(
            `Panel "${name}" already exists. Use "council panel edit ${name}" to modify or choose a different name.\n`,
          );
          throw new CliUserError(`Panel "${name}" already exists`);
        }

        const yamlPath = panelYamlPath(ctx.dataHome, name);
        // Existence is enforced atomically below via O_EXCL ('wx') at write
        // time — no fs.access pre-check, which would be racy (issue #307).

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

        const yamlContent = yaml.stringify(panel);
        const checksum = sha256(yamlContent);

        // DB row first so a YAML write failure can roll back cleanly.
        await ctx.panelRepo.create({
          name,
          description: fields.description ?? null,
          yamlPath,
          yamlChecksum: checksum,
        });
        let yamlWritten = false;
        try {
          await fs.mkdir(path.dirname(yamlPath), { recursive: true });
          try {
            // O_EXCL: fail if another concurrent create already wrote here.
            await fs.writeFile(yamlPath, yamlContent, { encoding: "utf-8", flag: "wx" });
            yamlWritten = true;
          } catch (writeErr) {
            if ((writeErr as NodeJS.ErrnoException).code === "EEXIST") {
              writeError(`Panel YAML already exists at ${displayPath(yamlPath)}\n`);
              throw new CliUserError(
                `Panel "${name}" already exists at ${yamlPath}`,
              );
            }
            throw writeErr;
          }
          await ctx.panelRepo.setMembers(name, fields.expertSlugs);
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

        write(`✓ Panel "${name}" created at ${displayPath(yamlPath)}\n`);
        write(`  Experts: ${fields.expertSlugs.join(", ")}\n`);
      });
    });
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
      'No experts found in the library. Create one first with "council expert create".',
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

function parseExpertList(raw: string): readonly string[] {
  const slugs = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

function buildListCommand(write: Writer): Command {
  const cmd = new Command("list");
  cmd
    .description("List user panels in the library")
    .option("--format <kind>", "Output format: table (default) or json", "table")
    .action(async (raw: { format?: string }) => {
      if (raw.format !== undefined && raw.format !== "table" && raw.format !== "json") {
        throw new Error(`Unknown --format value: ${raw.format}. Expected one of: table, json`);
      }
      const format: "table" | "json" = raw.format === "json" ? "json" : "table";

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
            const truncated = desc.length > 60 ? desc.slice(0, 57) + "..." : desc;
            return [p.name, String(members.length), truncated] as const;
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
        const row = await ctx.panelRepo.findByName(name);
        if (!row) {
          writeError(`Panel "${name}" not found.\n`);
          throw new CliUserError(`Panel "${name}" not found.`);
        }
        const memberSlugs = await ctx.panelRepo.getMembers(name);

        write(`Panel: ${row.name}\n`);
        write(`File:  ${displayPath(row.yamlPath)}\n`);
        if (row.description) {
          write(`Description: ${row.description}\n`);
        }
        write("\n");

        // Load YAML for defaults (mode, maxRounds) so inspect reflects on-disk state.
        try {
          const onDisk = await fs.readFile(row.yamlPath, "utf-8");
          const parsed = PanelDefinitionSchema.parse(yaml.parse(onDisk));
          if (parsed.defaults) {
            if (parsed.defaults.mode) write(`Mode:       ${parsed.defaults.mode}\n`);
            if (parsed.defaults.maxRounds !== undefined)
              write(`Max Rounds: ${parsed.defaults.maxRounds}\n`);
            if (parsed.defaults.model) write(`Model:      ${parsed.defaults.model}\n`);
            write("\n");
          }
        } catch {
          /* tolerate missing/invalid file at inspect time */
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
          writeError(`Panel "${name}" not found.\n`);
          throw new CliUserError(`Panel "${name}" not found.`);
        }
        const yamlPath = existing.yamlPath;
        const editor = resolveEditor();

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
}

function buildDocsCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("docs");
  cmd.description("Manage panel reference documents (list, link, unlink)");
  cmd.addCommand(buildDocsListCommand(write, writeError));
  cmd.addCommand(buildDocsLinkCommand(write, writeError));
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

function buildDocsLinkCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("link");
  cmd
    .description("Link an external folder for RAG retrieval")
    .argument("<name>", "Panel name")
    .requiredOption("--path <path>", "Absolute path to the folder to link")
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

/**
 * `council export <panel> --format markdown|json|adr [--output <path>]`
 * (ROADMAP §3.6)
 *
 * Snapshot the selected debate of a panel into a shareable artifact.
 * Three formats:
 *
 *   - **markdown** (default): readable transcript with H1 header
 *     (panel name + topic), a status line, and per-turn sections that
 *     include the expert displayName, model, round/seq, and content.
 *   - **json**: NDJSON stream identical to `council resume --format
 *     json` — same `synthesizeEvents()` helper. Useful as the
 *     canonical machine-readable archive.
 *   - **adr**: Architecture Decision Record markdown — Status,
 *     Context, Options Considered, Discussion, Decision sections
 *     populated from the panel's debate.
 *   - **share**: polished, launch-ready markdown that leads with the
 *     panel roster, key tensions, the recommendation, and next actions
 *     (derived from a recorded synthesis) before the full transcript.
 *     Synthesis-derived sections print an honest "Not recorded"
 *     placeholder when no synthesis was persisted — see `export-share.ts`.
 *
 * Pure read path: no engine, no LLM, and no debate-persistence side effects.
 * Reuses `synthesizeEvents()` from `src/memory/transcript.ts` (shared
 * with `council resume`). Unlike resume — which surfaces only the most
 * substantive single debate — export flattens every debate (original +
 * each resumption) into one continuous transcript so resumed sessions
 * don't lose earlier rounds. Panel name resolution mirrors resume's
 * exact-then-prefix fallback so `council export cfo` works when only
 * one panel name starts with `cfo`.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Command, Option } from "commander";

import { getCouncilDataHome, getCouncilHome, loadConfig } from "../../config/index.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository, type Turn } from "../../memory/repositories/turns.js";
import { synthesizeEvents, type TranscriptDocument } from "../../memory/transcript.js";

import { CliUserError } from "../cli-user-error.js";
import { resolveSession } from "../session-resolver.js";
import {
  sanitizeExportBlock,
  sanitizeExportBlockLines,
  sanitizeExportLine,
} from "./export-sanitize.js";
import { renderShare } from "./export-share.js";
import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

export const EXPORT_FORMATS = ["markdown", "json", "adr", "share"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
}

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly output?: string;
  readonly force?: boolean;
}

/**
 * True when `err` is a Node system error carrying an errno `code` string
 * (e.g. `ENOENT`, `EACCES`, `ELOOP`).
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as { code?: unknown }).code === "string";
}

/**
 * A short, path-free label for a Node system error, safe to print on a terminal.
 * `err.code` is an errno constant (e.g. `EACCES`, `ELOOP`) and never carries
 * user-controlled bytes — unlike `err.message`, which embeds the raw,
 * un-sanitized path. Never interpolate `err.message` into user-facing output.
 */
function errnoLabel(err: unknown): string {
  return isErrnoException(err) && typeof err.code === "string" ? err.code : "unknown error";
}

/**
 * Reject a relative `--output` whose resolved `target` escapes `root`.
 * `path.relative` yields a leading `..` (or an absolute path on Windows drive
 * changes) exactly when `target` is not contained by `root`.
 */
function assertWithinRoot(root: string, target: string, outputPath: string): void {
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new CliUserError(
      `Refusing to write export outside the working directory: '${sanitizeExportLine(outputPath)}'.`,
    );
  }
}

/**
 * `realpath` a target's parent directory so a symlinked ancestor cannot smuggle
 * the write out of the tree and so the final open/rename only has to guard the
 * LAST path component. A not-yet-existing parent has nothing to dereference, so
 * fall back to the lexical parent (the subsequent write surfaces a clean
 * `ENOENT`). Any other error (`EACCES`, `ELOOP`, ...) is surfaced as a sanitized
 * user error so the exit code is `EXIT_USER_ERROR` and no raw path leaks.
 */
async function realpathParentDir(parentDir: string, outputPath: string): Promise<string> {
  try {
    return await fs.realpath(parentDir);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return parentDir;
    }
    throw new CliUserError(
      `Cannot access export target '${sanitizeExportLine(outputPath)}': ${errnoLabel(err)}.`,
      { cause: err },
    );
  }
}

/**
 * Neutralize any leading block-level Markdown construct on a single line so
 * untrusted transcript text can never open a new block and forge document
 * structure (outline spoofing / section forgery). Covers the whole CommonMark
 * block-start class — ATX headings (`#`), setext underlines (`=`/`-`), thematic
 * breaks (`-`/`*`/`_`), list bullets (`-`/`*`/`+`), blockquotes (`>`), fenced
 * code (`` ` ``/`~`), raw-HTML blocks (`<`) and INDENTED code blocks.
 *
 * Two steps, in order:
 *   1. Strip leading indentation. A caller pins the line inside a list item with
 *      a fixed 2-space prefix; once a blank line closes that item's paragraph, a
 *      continuation indented 4+ columns (four spaces, or a single tab — which
 *      CommonMark expands to a 4-column stop) opens an INDENTED code block, and
 *      unlike the punctuation markers below there is no character to escape (the
 *      code block would even swallow an escaped marker as literal text). Removing
 *      the indentation keeps the content at the list-item paragraph column so it
 *      can never start a code block (#1884).
 *   2. Backslash-escape a single leading block marker so the de-indented line
 *      parses as a literal paragraph while preserving the visible text. (A
 *      blockquote prefix does NOT suppress a nested ATX heading — CommonMark
 *      renders `> # Foo` as a heading — so escaping, not quoting, is the robust
 *      fix.)
 */
function escapeBlockLeadingMarkdown(line: string): string {
  return line.replace(/^[ \t]+/, "").replace(/^([#>=~`*+_<-])/, "\\$1");
}

/**
 * Resolve and validate a user-supplied `--output` path before writing.
 *
 * `--output` accepts an arbitrary path, so treat it as hostile:
 *   - A RELATIVE path must stay within the working directory. `path.resolve`
 *     happily turns `../../../etc/passwd` into an absolute path that escapes
 *     the tree, so reject any relative input whose resolved target is not under
 *     `process.cwd()`. An absolute `--output` is an explicit, user-chosen
 *     location and is allowed (still subject to the guards below).
 *   - Lexical containment is not enough: a pre-planted symlink in the parent
 *     chain (e.g. `foo -> /etc` for a relative `foo/out.md`) stays lexically
 *     "inside" while pointing out of tree. Dereference the parent with
 *     `realpath`, re-check containment against the REAL parent, and return the
 *     dereferenced path so the final open/rename only faces the last component
 *     (this also closes the Windows gap where `O_NOFOLLOW` is unavailable).
 *   - Refuse a target that already exists unless it is a regular file the user
 *     explicitly opts to overwrite via `--force`, and refuse non-regular
 *     targets (directories, symlinks, devices) so we never follow a symlink to
 *     clobber an out-of-tree file.
 *   - Only `ENOENT` means "nothing is there yet"; every other `lstat`/`realpath`
 *     error (EACCES, ELOOP, ENOTDIR, ...) is real and is surfaced as a sanitized
 *     `CliUserError` (exit 1, no raw path/ANSI in stderr) rather than swallowed
 *     or rethrown as a raw Node error (which would exit 4 and leak the path).
 */
export async function resolveOutputPath(outputPath: string, force: boolean): Promise<string> {
  const resolved = path.resolve(outputPath);
  const isRelative = !path.isAbsolute(outputPath);

  // Cheap lexical pre-filter: reject an obvious `../` escape before touching the
  // filesystem so a non-existent escape target never reaches realpath/lstat.
  if (isRelative) {
    assertWithinRoot(path.resolve(process.cwd()), resolved, outputPath);
  }

  const realParent = await realpathParentDir(path.dirname(resolved), outputPath);
  const derefResolved = path.join(realParent, path.basename(resolved));

  // Re-check containment against the DEREFERENCED parent so a symlinked ancestor
  // that escapes the tree is caught even though it looked lexically contained.
  if (isRelative) {
    const realRoot = await fs
      .realpath(path.resolve(process.cwd()))
      .catch(() => path.resolve(process.cwd()));
    assertWithinRoot(realRoot, derefResolved, outputPath);
  }

  const existing = await fs.lstat(derefResolved).catch((err: unknown) => {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return undefined;
    }
    // A non-ENOENT lstat error (EACCES/ELOOP/ENOTDIR/...) is real. Surface it as
    // a sanitized user error so the exit code is EXIT_USER_ERROR (1) and no raw,
    // un-sanitized path (with ANSI/control bytes) reaches the terminal.
    throw new CliUserError(
      `Cannot access export target '${sanitizeExportLine(outputPath)}': ${errnoLabel(err)}.`,
      { cause: err },
    );
  });
  if (existing) {
    if (!existing.isFile()) {
      throw new CliUserError(
        `Refusing to write export to '${sanitizeExportLine(outputPath)}': not a regular file.`,
      );
    }
    if (!force) {
      throw new CliUserError(
        `Refusing to overwrite existing file '${sanitizeExportLine(outputPath)}'. Pass --force to overwrite.`,
      );
    }
  }
  return derefResolved;
}

/**
 * Write the rendered export to `resolvedPath` without ever following a symlink
 * or truncating a file swapped in after validation (a TOCTOU race).
 *
 * `resolveOutputPath` already dereferenced the parent directory, so only the
 * final component is still at risk of a swap. Two strategies keep the write safe
 * on EVERY platform — including where `O_NOFOLLOW` is unavailable: it is
 * `undefined` on Windows, so `?? 0` degrades the flag to a no-op there and the
 * `O_EXCL` create / `rename` replace below carry the protection instead.
 *
 *   - **create (no --force):** open with `O_CREAT | O_EXCL` (plus `O_NOFOLLOW`
 *     where available). `O_EXCL` makes creation atomic and fails with `EEXIST`
 *     if ANYTHING — regular file or symlink — already occupies the path, so a
 *     target that appeared after the pre-check is never clobbered or followed.
 *   - **overwrite (--force):** write a uniquely-named private temp sibling in
 *     the same directory, then `fs.rename` it over the target. `rename` is
 *     atomic and never follows a destination symlink, so a regular file swapped
 *     in at the path is replaced wholesale rather than truncated in place — the
 *     old `O_TRUNC` opened and zeroed whatever inode was there. A pre-write
 *     `lstat` still refuses a symlink / non-regular target outright as defense
 *     in depth, and the temp is removed if the rename fails.
 *
 * Any raw Node fs error from these steps (`ENOTDIR`, `EACCES`, `EEXIST`,
 * `ELOOP`, ...) is wrapped in a sanitized `CliUserError` (exit 1, no raw
 * path/ANSI in stderr) instead of rethrown as-is — a raw rethrow exits 4
 * (INTERNAL) and leaks the un-sanitized path — mirroring `resolveOutputPath`.
 */
export async function writeExportArtifact(
  resolvedPath: string,
  contents: string,
  force: boolean,
  writeError: Writer = defaultErrorWriter,
): Promise<void> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;

  try {
    if (!force) {
      const handle = await fs.open(
        resolvedPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600,
      );
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
      return;
    }

    // --force: refuse a symlink / non-regular target outright (rename would not
    // follow it, but we must not silently replace one either), then write a
    // private temp sibling and atomically rename it into place.
    const existing = await fs.lstat(resolvedPath).catch((err: unknown) => {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    });
    if (existing && !existing.isFile()) {
      throw new CliUserError("Refusing to overwrite a non-regular-file export target.");
    }

    const dir = path.dirname(resolvedPath);
    const tempPath = path.join(
      dir,
      `.${path.basename(resolvedPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const handle = await fs.open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    // Guard every step between creating the O_EXCL temp and a successful rename:
    // a rejected writeFile, close, or rename must not leak the partially-written
    // temp sibling. On success the rename has consumed the temp, so skip the rm.
    let renamed = false;
    try {
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, resolvedPath);
      renamed = true;
    } finally {
      if (!renamed) {
        // Best-effort remove the 0o600 temp sibling so a failed write/close/
        // rename cannot leave partially-written transcript content on disk. That
        // primary failure is what must propagate, so this cleanup NEVER re-throws
        // (a thrown rm rejection would mask the original error). `force: true`
        // already ignores ENOENT ("already gone"); the guard below is
        // belt-and-suspenders for an edge/injected ENOENT. Any OTHER rejection
        // (EACCES/EBUSY/EPERM under a Windows AV/indexer lock, EIO on a network/
        // removable FS) means the temp survived — surface a sanitized, single-
        // line diagnostic so the stray sensitive file is observable rather than
        // silently swallowed (#2100).
        await fs.rm(tempPath, { force: true }).catch((rmErr: unknown) => {
          if (isErrnoException(rmErr) && rmErr.code === "ENOENT") {
            return;
          }
          writeError(
            `!! Failed to remove temporary export file '${sanitizeExportLine(tempPath)}' after a failed write (${errnoLabel(rmErr)}); it may still contain exported content and require manual cleanup.\n`,
          );
        });
      }
    }
  } catch (err: unknown) {
    // The non-regular-file refusal is already a sanitized CliUserError — surface
    // it unchanged. Every other failure is a raw Node fs error
    // (ENOTDIR/EACCES/EEXIST/ELOOP/...) whose message embeds the un-sanitized
    // path; rethrown as-is it would exit 4 (INTERNAL) and leak path/ANSI bytes to
    // the terminal. Wrap it in a sanitized CliUserError so the exit code is
    // EXIT_USER_ERROR (1) with no raw path/control bytes — mirroring
    // resolveOutputPath. (ENOENT short-circuits above return undefined and never
    // reach here.)
    if (err instanceof CliUserError) {
      throw err;
    }
    throw new CliUserError(
      `Cannot write export to '${sanitizeExportLine(resolvedPath)}' (${errnoLabel(err)}).`,
      { cause: err },
    );
  }
}

export function buildExportCommand(deps: ExportCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("export");
  cmd
    .description("Export a panel transcript to markdown, json, adr, or share format")
    .argument("<panel>", "Panel name to export (as shown by `council sessions`)")
    .addOption(
      new Option("--format <kind>", "Output format")
        .choices([...EXPORT_FORMATS])
        .default("markdown"),
    )
    .option("--output <path>", "Write to file instead of stdout (default: stdout)")
    .option("--force", "Overwrite the --output file if it already exists")
    .action(async (panelName: string, raw: ExportOptions) => {
      const opts: ExportOptions = {
        format: raw.format,
        force: raw.force === true,
        ...(raw.output !== undefined ? { output: raw.output } : {}),
      };

      const councilHome = getCouncilHome();
      const dataHome = getCouncilDataHome();
      const dbPath = path.join(councilHome, "council.db");
      const db = await createDatabase(dbPath);
      try {
        let resolvedName: string;
        // Buffer stderr from the first attempt so we can discard it if we
        // retry with a different data home — emitting it eagerly would
        // print a contradictory "No panel found matching ..." line right
        // before the real "exists but has no debates yet ..." diagnostic.
        let firstAttemptStderr = "";
        const bufferedWriteError: Writer = (chunk: string) => {
          firstAttemptStderr += chunk;
        };
        try {
          resolvedName = await resolveSession({
            db,
            dataHome,
            panelArg: panelName,
            writeError: bufferedWriteError,
          });
        } catch (err: unknown) {
          const shouldRetryWithConfig =
            err instanceof CliUserError &&
            err.message.startsWith("No panel found matching") &&
            !process.env["COUNCIL_DATA_HOME"]?.length;
          if (!shouldRetryWithConfig) {
            writeError(firstAttemptStderr);
            throw err;
          }

          const configuredDataHome = getCouncilDataHome(await loadConfig());
          if (configuredDataHome === dataHome) {
            writeError(firstAttemptStderr);
            throw err;
          }
          resolvedName = await resolveSession({
            db,
            dataHome: configuredDataHome,
            panelArg: panelName,
            writeError,
          });
        }
        const doc = await loadFullPanelTranscript(db, resolvedName);
        const rendered = renderForExport(doc, opts.format);

        if (opts.output !== undefined) {
          const resolvedOutput = await resolveOutputPath(opts.output, opts.force === true);
          await writeExportArtifact(resolvedOutput, rendered, opts.force === true, writeError);
          writeError(`Wrote ${opts.format} export to ${sanitizeExportLine(opts.output)}\n`);
          if (opts.format !== "json") {
            const safeResolvedName = sanitizeExportLine(resolvedName);
            write(
              `Next: council conclude ${safeResolvedName} | council resume ${safeResolvedName}\n`,
            );
          }
          return;
        }
        write(rendered);
        if (opts.format !== "json") {
          const safeResolvedName = sanitizeExportLine(resolvedName);
          write(
            `Next: council conclude ${safeResolvedName} | council resume ${safeResolvedName}\n`,
          );
        }
      } finally {
        await db.destroy().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
        });
      }
    });

  cmd.addHelpText(
    "after",
    `
Examples:
  $ council export my-panel                         # markdown to stdout
  $ council export my-panel --format adr            # Architecture Decision Record
  $ council export my-panel --format share          # polished, shareable summary
  $ council export my-panel --format json --output transcript.ndjson
  $ council export my-panel --output transcript.md --force   # overwrite existing
`,
  );

  return cmd;
}

function renderForExport(doc: TranscriptDocument, format: ExportFormat): string {
  switch (format) {
    case "markdown":
      return renderMarkdown(doc);
    case "json":
      return renderJson(doc);
    case "adr":
      return renderAdr(doc);
    case "share":
      return renderShare(doc);
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown export format: ${String(_exhaustive)}`);
    }
  }
}

export function renderJson(doc: TranscriptDocument): string {
  // NDJSON identical to `council resume --format json`.
  return (
    synthesizeEvents(doc)
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
}

export function renderMarkdown(doc: TranscriptDocument): string {
  const slugById = new Map<string, string>();
  const nameBySlug = new Map<string, string>();
  const modelBySlug = new Map<string, string>();
  for (const e of doc.experts) {
    const safeSlug = sanitizeExportLine(e.slug);
    slugById.set(e.id, safeSlug);
    nameBySlug.set(safeSlug, sanitizeExportLine(e.displayName));
    modelBySlug.set(safeSlug, sanitizeExportLine(e.model));
  }

  const lines: string[] = [];
  lines.push(`# ${sanitizeExportLine(doc.panel.name)}`);
  if (doc.panel.topic) lines.push(`> ${sanitizeExportLine(doc.panel.topic)}`);
  lines.push("");
  lines.push(`**Prompt:** ${sanitizeExportLine(doc.latestDebate.prompt)}`);
  lines.push(`**Status:** ${sanitizeExportLine(doc.latestDebate.status)}`);
  if (doc.latestDebate.endedAt) {
    lines.push(`**Ended:** ${sanitizeExportLine(doc.latestDebate.endedAt)}`);
  }
  lines.push("");

  if (doc.experts.length > 0) {
    lines.push("## Panel");
    for (const e of doc.experts) {
      lines.push(
        `- **${sanitizeExportLine(e.displayName)}** (\`${sanitizeExportLine(
          e.slug,
        )}\`) - ${sanitizeExportLine(e.model)}`,
      );
    }
    lines.push("");
  }

  lines.push("## Transcript");
  lines.push("");
  if (doc.turns.length === 0) {
    lines.push("_No turns recorded._");
    lines.push("");
  } else {
    let lastRound = -1;
    for (const t of doc.turns) {
      if (t.round !== lastRound) {
        lines.push(`### Round ${t.round + 1}`);
        lines.push("");
        lastRound = t.round;
      }
      const slug = t.expertId ? slugById.get(t.expertId) : undefined;
      const display = sanitizeExportLine(slug ? (nameBySlug.get(slug) ?? slug) : t.speakerKind);
      const model = slug ? modelBySlug.get(slug) : undefined;
      lines.push(`#### ${display}${model ? ` _(${model})_` : ""}`);
      lines.push("");
      // Render multi-line content as a markdown block-quote so it reads as the
      // expert's "voice". Neutralize each untrusted paragraph's leading block
      // marker first: CommonMark still opens block constructs INSIDE a blockquote
      // (`> ## x` -> heading, `> ---`/`> ===` -> rule/setext heading, `> ``` ->
      // code fence, `> <x>` -> raw HTML), so a leading marker would otherwise
      // forge structure in the exported outline (outline spoofing, #2110).
      for (const para of sanitizeExportBlockLines(t.content)) {
        lines.push(`> ${escapeBlockLeadingMarkdown(para)}`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push(`_Exported by Council on ${new Date().toISOString()}_`);
  return lines.join("\n") + "\n";
}

const ADR_SHORT_TURN_MAX_CHARS = 40;

export function renderAdr(doc: TranscriptDocument): string {
  // Architecture Decision Record — populated from the panel's selected
  // debate. Heuristics: opening turn per expert = their position;
  // last turn per expert = their final synthesis (the Decision).
  const slugById = new Map<string, string>();
  const nameBySlug = new Map<string, string>();
  for (const e of doc.experts) {
    const safeSlug = sanitizeExportLine(e.slug);
    slugById.set(e.id, safeSlug);
    nameBySlug.set(safeSlug, sanitizeExportLine(e.displayName));
  }

  // For each expert: collect their first turn ("position") and last
  // turn ("synthesis"). May be the same turn for short debates.
  interface ExpertContrib {
    readonly displayName: string;
    readonly position: string;
    readonly synthesis: string;
  }
  const contribs = new Map<string, { firstTurn: string; lastTurn: string; displayName: string }>();
  for (const t of doc.turns) {
    if (!t.expertId) continue;
    const slug = slugById.get(t.expertId);
    if (!slug) continue;
    const displayName = nameBySlug.get(slug) ?? slug;
    const existing = contribs.get(slug);
    if (!existing) {
      contribs.set(slug, { firstTurn: t.content, lastTurn: t.content, displayName });
    } else {
      existing.lastTurn = t.content;
    }
  }
  const expertContribs: ExpertContrib[] = [];
  for (const c of contribs.values()) {
    expertContribs.push({
      displayName: sanitizeExportLine(c.displayName),
      position: sanitizeExportBlock(c.firstTurn),
      synthesis: sanitizeExportBlock(c.lastTurn),
    });
  }

  const status = deriveAdrStatus(doc);

  const lines: string[] = [];
  lines.push(`# Decision Record: ${sanitizeExportLine(doc.panel.topic ?? doc.originalPrompt)}`);
  lines.push("");
  lines.push(`## Status`);
  lines.push("");
  lines.push(sanitizeExportLine(status));
  lines.push("");
  lines.push(`## Context`);
  lines.push("");
  lines.push(sanitizeExportBlock(doc.originalPrompt));
  lines.push("");
  lines.push(`## Options Considered`);
  lines.push("");
  if (expertContribs.length === 0) {
    lines.push("_No expert positions recorded._");
  } else {
    for (const c of expertContribs) {
      lines.push(`### ${c.displayName}'s position`);
      lines.push("");
      // Neutralize any leading block marker before quoting — a blockquote does
      // not suppress a nested heading/rule/code/HTML block, so model-derived
      // position text could otherwise forge the ADR outline (#2110).
      for (const para of sanitizeExportBlockLines(c.position)) {
        lines.push(`> ${escapeBlockLeadingMarkdown(para)}`);
      }
      lines.push("");
    }
  }
  lines.push(`## Discussion`);
  lines.push("");
  if (doc.turns.length <= expertContribs.length) {
    lines.push("_Single round — no further discussion recorded. See positions above._");
  } else {
    lines.push("Full transcript:");
    lines.push("");
    let lastRound = -1;
    for (const t of doc.turns) {
      if (t.round !== lastRound) {
        lines.push(`**Round ${t.round + 1}**`);
        lines.push("");
        lastRound = t.round;
      }
      const slug = t.expertId ? slugById.get(t.expertId) : undefined;
      const display = slug ? (nameBySlug.get(slug) ?? slug) : sanitizeExportLine(t.speakerKind);
      const [firstLine = "", ...restLines] = sanitizeExportBlockLines(t.content);
      lines.push(`- **${display}**: ${firstLine}`);
      for (const contLine of restLines) {
        // Keep continuation lines inside the list item AND neutralize any
        // leading block construct so a multi-line turn can neither break out to
        // a top-level ADR section nor forge a heading/rule/code fence/indented
        // code block in the rendered outline (#1884). The first line is safe
        // unescaped: it sits mid-line after the `- **name**: ` bullet, where no
        // block starts.
        lines.push(contLine.length > 0 ? `  ${escapeBlockLeadingMarkdown(contLine)}` : "");
      }
    }
    lines.push("");
  }
  lines.push(`## Decision`);
  lines.push("");
  if (expertContribs.length === 0) {
    lines.push("_No decision recorded._");
  } else {
    for (const c of expertContribs) {
      lines.push(`### ${c.displayName}'s final position`);
      lines.push("");
      // Same leading block-marker neutralization as the Options blockquote (#2110).
      for (const para of sanitizeExportBlockLines(c.synthesis)) {
        lines.push(`> ${escapeBlockLeadingMarkdown(para)}`);
      }
      lines.push("");
    }
  }
  lines.push("---");
  lines.push(`_Generated by Council on ${new Date().toISOString()}_`);
  return lines.join("\n") + "\n";
}

function deriveAdrStatus(doc: TranscriptDocument): string {
  if (doc.latestDebate.status !== "completed") {
    return `${doc.latestDebate.status} (incomplete)`;
  }

  if (doc.turns.length <= 2 || hasOnlyVeryShortTurns(doc.turns)) {
    return "Proposed";
  }

  return "Accepted";
}

function hasOnlyVeryShortTurns(turns: readonly { readonly content: string }[]): boolean {
  return (
    turns.length > 0 &&
    turns.every((turn) => turn.content.trim().length <= ADR_SHORT_TURN_MAX_CHARS)
  );
}

/**
 * Load a panel's full conversational history for export — every debate
 * (original + every resumption) flattened into a single TranscriptDocument.
 *
 * Differs from `loadTranscript()` (used by resume), which intentionally
 * surfaces only the most-substantive single debate. Export needs the
 * complete record so resumed sessions don't lose earlier rounds.
 *
 * Round numbers are renumbered to be globally monotonic across debates
 * so the existing markdown/json/adr renderers produce a continuous
 * "Round 1, 2, 3, ..." sequence without needing any format changes.
 * `originalPrompt` is the first debate's prompt (the original question
 * the panel was convened around); `latestDebate` reflects the most
 * recent debate's status/timestamps.
 */
async function loadFullPanelTranscript(
  db: CouncilDatabase,
  panelName: string,
): Promise<TranscriptDocument> {
  const panelRepo = new PanelRepository(db);
  const expertRepo = new ExpertRepository(db);
  const debateRepo = new DebateRepository(db);
  const turnRepo = new TurnRepository(db);

  const panel = await panelRepo.findByName(panelName);
  if (!panel) {
    throw new Error(
      `No panel found with name '${panelName}'. Run \`council sessions\` to list available panels.`,
    );
  }
  const experts = await expertRepo.findByPanelId(panel.id);
  const debates = await debateRepo.findByPanelId(panel.id);
  if (debates.length === 0) {
    throw new Error(
      `Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`,
    );
  }

  const originalDebate = debates[0];
  const latestDebate = debates[debates.length - 1];
  if (!originalDebate || !latestDebate) {
    throw new Error(
      `Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`,
    );
  }

  const flattenedTurns: Turn[] = [];
  let roundOffset = 0;
  for (const debate of debates) {
    const debateTurns = await turnRepo.findByDebateId(debate.id);
    if (debateTurns.length === 0) continue;
    let maxRound = 0;
    for (const t of debateTurns) {
      flattenedTurns.push({ ...t, round: t.round + roundOffset });
      if (t.round > maxRound) maxRound = t.round;
    }
    roundOffset += maxRound + 1;
  }

  return {
    panel,
    experts,
    originalPrompt: originalDebate.prompt,
    latestDebate: {
      id: latestDebate.id,
      prompt: latestDebate.prompt,
      status: latestDebate.status,
      startedAt: latestDebate.startedAt,
      endedAt: latestDebate.endedAt,
    },
    turns: flattenedTurns,
  };
}

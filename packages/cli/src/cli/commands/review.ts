/**
 * `council review [--diff-file <path>] [--base <ref>] [--engine <kind>]`
 *
 * Runs the built-in **code-review** expert panel over a unified diff and
 * prints the panel's review. The diff is sourced from, in precedence order:
 *
 *   1. `--diff-file <path>` — read VERBATIM from a file, or `-` for stdin.
 *   2. the default `git diff <base>` (base defaults to HEAD), capturing the
 *      working-tree changes relative to `<base>`.
 *
 * The diff becomes the debate topic; the run reuses the same engine path as
 * `convene` (load template → build expert prompts → persist panel/experts →
 * stream via `runWithEngine`).
 *
 * Privacy: the diff is SENT to the configured AI engine (e.g. Copilot) for
 * review. With `--engine mock` the command runs fully offline (deterministic,
 * no network) — the supported offline/test path. Nothing is sent unless the
 * user invokes this command.
 *
 * Foundation for a future "Council reviews this PR" GitHub Action. Fetching a
 * PR (`--pr <n>`) is intentionally out of scope here — this command stays
 * local-diff focused.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";

import { Command, Option } from "commander";
import { ulid } from "ulid";

import { CliUserError } from "../cli-user-error.js";
import { getCouncilHome, loadConfig, resolveEngine } from "../../config/index.js";
import { buildSystemPrompt } from "../../core/prompt-builder.js";
import { resolveModel } from "../../core/model-resolver.js";
import { loadTemplate, type ResolvedPanelDefinition } from "../../core/template-loader.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { defaultErrorWriter, defaultWriter, isQuiet, type Writer } from "./writer.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";
import { readTextInput } from "../read-text-input.js";
import { toSingleLineDisplay } from "../strip-control-chars.js";

/** Built-in panel template this command always runs. */
const REVIEW_TEMPLATE = "code-review";
/** Default git ref to diff the working tree against. */
const DEFAULT_BASE_REF = "HEAD";
/** Soft per-response word budget (opening-phase anchor), matching sibling commands. */
const DEFAULT_MAX_WORDS = 250;
/** Used only if the template omits its own `defaults.maxRounds`. */
const FALLBACK_MAX_ROUNDS = 3;
const GIT_DIFF_TIMEOUT_MS = 15_000;
// Diffs can be large; allow well above execFile's 1 MiB default.
const GIT_DIFF_MAX_BUFFER = 50 * 1024 * 1024;

/** Runs `git diff <base>` and returns its stdout. Injectable for tests. */
export type GitDiffRunner = (base: string) => Promise<string>;

const defaultGitDiff: GitDiffRunner = (base) =>
  new Promise<string>((resolve, reject) => {
    // Argv array (never a shell string) so refs are not shell-expanded.
    // Use --end-of-options to prevent base from being parsed as a git option
    // (defense in depth — the caller should also reject leading dashes).
    execFile(
      "git",
      ["diff", "--end-of-options", base],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: GIT_DIFF_TIMEOUT_MS,
        maxBuffer: GIT_DIFF_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error) {
          const detail = error instanceof Error ? error.message : String(error);
          reject(
            new Error(
              `Could not run \`git diff ${base}\` (are you inside a git repository?): ${detail}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface ReviewCommandDeps {
  /** Test-only override: takes precedence over the resolved engine kind. */
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  /** Reads stdin for `--diff-file -`. Defaults to process stdin. */
  readonly readStdin?: () => Promise<string>;
  /** Runs `git diff <base>` for the default diff source. Injectable for tests. */
  readonly gitDiff?: GitDiffRunner;
}

interface ReviewOptions {
  readonly diffFile?: string;
  readonly base?: string;
  readonly engine?: EngineKind;
  readonly format?: string;
  readonly maxRounds?: number;
  readonly maxWords?: number;
}

export function buildReviewCommand(deps: ReviewCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;
  const gitDiff: GitDiffRunner = deps.gitDiff ?? defaultGitDiff;

  const cmd = new Command("review");
  cmd
    .description(
      "Run the built-in code-review expert panel over a diff and print the review. " +
        "The diff is SENT to the configured AI engine (e.g. Copilot); use --engine mock to run offline.",
    )
    .option(
      "--diff-file <path>",
      "Read the unified diff from a file, or `-` to read stdin. " +
        "When omitted, Council reviews `git diff <base>` (your local changes).",
    )
    .option(
      "--base <ref>",
      "Git ref to diff the working tree against when --diff-file is omitted",
      DEFAULT_BASE_REF,
    )
    .addOption(
      new Option("--engine <kind>", "Engine to use (default: from config)").choices([
        ...ENGINE_KINDS,
      ]),
    )
    .addOption(
      new Option("--format <kind>", "Output format").choices([...RENDERER_FORMATS]).default("auto"),
    )
    .option(
      "--max-rounds <n>",
      "Max debate rounds (default: the code-review panel's own default)",
      (v) => {
        const parsed = Number(v);
        if (!Number.isInteger(parsed)) {
          throw new Error(`--max-rounds must be an integer (got: ${v})`);
        }
        return parsed;
      },
    )
    .option(
      "--max-words <n>",
      "Soft per-response word budget (opening-phase anchor; structured mode scales the other phases)",
      (v) => {
        const parsed = Number(v);
        if (!Number.isInteger(parsed)) {
          throw new Error(`--max-words must be an integer (got: ${v})`);
        }
        return parsed;
      },
      DEFAULT_MAX_WORDS,
    )
    .action(async (raw: ReviewOptions) => {
      // 1. Resolve the diff text from the chosen source (file / stdin / git).
      const diff = await resolveDiff(raw, {
        gitDiff,
        ...(deps.readStdin !== undefined ? { readStdin: deps.readStdin } : {}),
        writeError,
      });

      // 2. Reject empty / whitespace-only diffs — there is nothing to review.
      if (diff.trim().length === 0) {
        const message =
          raw.diffFile !== undefined
            ? "The provided diff is empty — there is nothing to review."
            : `No changes to review: \`git diff ${raw.base ?? DEFAULT_BASE_REF}\` produced an empty diff. ` +
              "Make or stage changes, pass a different --base <ref>, or supply a diff with --diff-file <path>.";
        writeError(message + "\n");
        throw new CliUserError(message);
      }

      // 3. Resolve engine, format, model, and the code-review panel.
      const config = await loadConfig();
      const resolvedEngine = resolveEngine(raw.engine, config);
      const format = parseFormat(raw.format);
      const defaultModel = config.defaults.model;

      const template = await loadTemplate(REVIEW_TEMPLATE);
      const mode = template.defaults?.mode ?? "freeform";
      const maxRounds = raw.maxRounds ?? template.defaults?.maxRounds ?? FALLBACK_MAX_ROUNDS;
      const maxWords = Number.isFinite(raw.maxWords)
        ? (raw.maxWords ?? DEFAULT_MAX_WORDS)
        : DEFAULT_MAX_WORDS;

      // 4. The diff IS the topic. Experts get a short task in their system
      //    prompt; the full diff is the user turn fed to every expert.
      const reviewTask =
        "Review the provided unified code diff. Surface bugs, security issues, performance " +
        "concerns, and maintainability problems from your area of expertise. Be specific and " +
        "reference the relevant hunks.";
      const reviewPrompt = `${reviewTask}\n\n\`\`\`diff\n${diff}\n\`\`\``;

      // 5. Privacy / engine notice. The mock warning doubles as the offline
      //    signal; real engines get an explicit "your diff is sent" notice.
      if (resolvedEngine === "mock") {
        writeError(
          "\n!! [MOCK ENGINE] Running with deterministic offline mock — responses are NOT real.\n\n",
        );
      } else if (!isQuiet()) {
        writeError(
          `\nℹ Sending this diff (${countLines(diff)} lines) to the '${resolvedEngine}' engine for review.\n\n`,
        );
      }

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const experts = buildReviewExperts(
          template,
          reviewTask,
          template.defaults?.model,
          defaultModel,
        );

        const panelRepo = new PanelRepository(db);
        const expertRepo = new ExpertRepository(db);
        const panel = await panelRepo.create({
          name: `${template.name}-${new Date().toISOString().slice(0, 19)}`,
          topic: reviewTask,
          copilotHome: path.join(getCouncilHome(), "copilot"),
          configJson: JSON.stringify({
            template: template.name,
            mode,
            maxRounds,
            maxWords,
            engine: resolvedEngine,
            command: "review",
          }),
        });

        const expertSlugToId: Record<string, string> = {};
        for (const e of experts) {
          const row = await expertRepo.create({
            panelId: panel.id,
            slug: e.slug,
            displayName: e.displayName,
            model: e.model,
            systemMessage: e.systemMessage,
          });
          expertSlugToId[e.slug] = row.id;
        }

        await runWithEngine({
          engineKind: resolvedEngine,
          engineFactory: deps.engineFactory,
          experts,
          debateConfig: {
            maxRounds,
            maxWordsPerResponse: maxWords,
            mode,
            qualityGate: config.qualityGate,
          },
          prompt: reviewPrompt,
          panelId: panel.id,
          expertSlugToId,
          moderator: "round-robin",
          format,
          write,
          writeError,
          quiet: isQuiet(),
          db,
          preamble: () => {
            write(`\n# Code review — ${toSingleLineDisplay(template.name)}\n`);
            write(
              `Experts: ${experts.map((e) => toSingleLineDisplay(e.displayName)).join(", ")}\n`,
            );
            write(`Rounds: ${maxRounds} | Engine: ${resolvedEngine}\n\n`);
          },
        });

        if (format !== "json" && !isQuiet()) {
          write(
            "\nTip: pipe a diff with `git diff | council review --diff-file - --engine copilot`, " +
              "or review against a branch with `council review --base main --engine copilot`.\n",
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
  $ council review --engine copilot                        # review your local \`git diff\`
  $ council review --base main --engine copilot            # review everything since main
  $ council review --diff-file changes.diff --engine copilot
  $ git diff | council review --diff-file - --engine copilot

Privacy: the diff is SENT to the configured AI engine (e.g. Copilot) for review.
Use --engine mock to run fully offline with a deterministic (non-real) response.
`,
  );

  return cmd;
}

/**
 * Resolve the diff text from the requested source. Errors are written to
 * stderr and re-thrown as {@link CliUserError} so the top-level handler
 * exits non-zero without a stack trace.
 */
async function resolveDiff(
  raw: ReviewOptions,
  ctx: { gitDiff: GitDiffRunner; readStdin?: () => Promise<string>; writeError: Writer },
): Promise<string> {
  if (raw.diffFile !== undefined) {
    try {
      return await readTextInput(
        raw.diffFile,
        ctx.readStdin !== undefined ? { readStdin: ctx.readStdin } : {},
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.writeError(message + "\n");
      throw new CliUserError(message);
    }
  }

  const base = raw.base ?? DEFAULT_BASE_REF;

  // Guard against argument injection: a --base value starting with dash
  // (e.g., --output=/tmp/evil or --ext-diff) would be parsed by git as an
  // option, not a revision, enabling potential misuse.
  if (base.startsWith("-")) {
    const message =
      `Invalid --base value: "${base}". The --base argument must be a git ref ` +
      "(e.g., HEAD, main, a SHA), not an option starting with dash.";
    ctx.writeError(message + "\n");
    throw new CliUserError(message);
  }

  try {
    return await ctx.gitDiff(base);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.writeError(message + "\n");
    throw new CliUserError(message);
  }
}

/** Build engine-ready expert specs from the code-review template. */
function buildReviewExperts(
  template: ResolvedPanelDefinition,
  task: string,
  panelDefaultModel: string | undefined,
  configDefaultModel: string,
): ExpertSpec[] {
  return template.experts.map((def) => ({
    id: ulid(),
    slug: def.slug,
    displayName: def.displayName,
    model: resolveModel({ expertModel: def.model, panelDefaultModel, configDefaultModel }),
    systemMessage: buildSystemPrompt(def, undefined, task),
  }));
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function parseFormat(raw: string | undefined): RendererFormat {
  if (raw === undefined) return "auto";
  if ((RENDERER_FORMATS as readonly string[]).includes(raw)) {
    return raw as RendererFormat;
  }
  throw new Error(
    `Unknown --format value: ${raw}. Expected one of: ${RENDERER_FORMATS.join(", ")}`,
  );
}

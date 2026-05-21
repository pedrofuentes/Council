/**
 * Chat renderer — formatting utilities for the interactive `council chat`
 * command.
 *
 * Unlike `PlainRenderer` / `JsonRenderer`, which consume a `DebateEvent`
 * stream, this module exposes imperative methods that the chat command
 * calls directly as the conversation progresses: session status banners,
 * the user prompt prefix, streamed expert deltas, and system notices.
 *
 * Expert names are color-coded with a fixed palette assigned by
 * registration order. The same slug always gets the same color in a
 * session, so users can visually track who is speaking.
 */
import chalk, { type ChalkInstance } from "chalk";

import { stripControlChars } from "../strip-control-chars.js";

import type { ExpertColor } from "./ink/colors.js";
import { EXPERT_COLOR_PALETTE, formatExpertPrefix } from "./ink/colors.js";
import type { Sink } from "./types.js";

/**
 * Color palette for expert names. Uses the shared unified palette from
 * `ink/colors.ts` so both Ink and Chat renderers assign the same expert
 * the same color. Cycled modulo length when a panel has more experts
 * than colors.
 */
const EXPERT_COLORS: readonly ChalkInstance[] = EXPERT_COLOR_PALETTE.map(
  (name: ExpertColor): ChalkInstance => chalk[name],
);

export interface ChatRendererOptions {
  readonly sink: Sink;
  /** Map of expert slugs to their display names. Iteration order = color order. */
  readonly experts: ReadonlyMap<string, string>;
}

export interface ChatRenderer {
  /** Show session start/resume message. */
  showSessionStatus(message: string): void;

  /** Show the user input prompt prefix ("You > "). No trailing newline. */
  showPrompt(): void;

  /** Show a user message (for transcript replay). */
  showUserMessage(content: string): void;

  /** Show the start of an expert's response (name prefix with color). */
  startExpertResponse(expertSlug: string): void;

  /** Stream a chunk of an expert's response. No trailing newline. */
  streamChunk(text: string): void;

  /** End the current expert's response (newline). */
  endExpertResponse(): void;

  /** Show a system message (info, warning, error). Errors go to stderr. */
  showSystem(message: string, level?: "info" | "warn" | "error"): void;

  /** Show a separator between conversation sections. */
  showSeparator(): void;
}

const PROMPT_PREFIX = "You > ";

/**
 * Create a chat renderer with consistent expert color assignment.
 * Colors are assigned by insertion order in the provided expert map.
 */
export function createChatRenderer(options: ChatRendererOptions): ChatRenderer {
  const { sink, experts } = options;

  // Pre-compute slug → color and slug → index from registration order so
  // color assignment is deterministic across multiple renderer instances
  // given the same map.
  const colorBySlug = new Map<string, ChalkInstance>();
  const indexBySlug = new Map<string, number>();
  let index = 0;
  for (const slug of experts.keys()) {
    const color = EXPERT_COLORS[index % EXPERT_COLORS.length];
    if (color) colorBySlug.set(slug, color);
    indexBySlug.set(slug, index);
    index += 1;
  }

  const write = (text: string): void => sink.write(text);
  const writeError = (text: string): void => {
    if (sink.writeError) sink.writeError(text);
    else sink.write(text);
  };

  /**
   * Sanitize multi-line text (streamed response bodies) for terminal display.
   *
   * Builds on the shared `stripControlChars` helper (which removes ANSI/OSC
   * escapes, most C0 controls, and the C1 control range U+0080–U+009F) but
   * additionally strips `\r`. The shared
   * helper preserves `\r` for transcript fidelity; in a live TTY, however, a
   * carriage return rewinds the cursor to column 0 and lets a malicious
   * chunk overwrite the current line (e.g. spoof a `You > ` prompt). Newlines
   * (`\n`) and tabs (`\t`) are still allowed here — they're legitimate output
   * for multi-paragraph responses.
   */
  const sanitizeMultiline = (text: string): string =>
    stripControlChars(text).replace(/\r/g, "");

  /**
   * Sanitize single-line text (display names, status/system messages, replayed
   * user input) for terminal display.
   *
   * Same as `sanitizeMultiline`, but additionally collapses `\n` and other
   * Unicode line-break characters to a single space. Without this, an
   * attacker-controlled display name or status message could inject extra
   * terminal lines and spoof chat UI (e.g. `"Mallory\nYou > hacked"`
   * rendering as a fake prompt on the next row).
   */
  const sanitizeSingleLine = (text: string): string =>
    sanitizeMultiline(text).replace(/[\n\v\f\u0085\u2028\u2029]+/g, " ");

  const colorFor = (slug: string): ChalkInstance => {
    const existing = colorBySlug.get(slug);
    if (existing) return existing;
    // Unknown slug — assign next color in cycle so subsequent calls stay stable.
    const nextIdx = colorBySlug.size;
    const next = EXPERT_COLORS[nextIdx % EXPERT_COLORS.length] ?? EXPERT_COLORS[0] ?? chalk.cyan;
    colorBySlug.set(slug, next);
    indexBySlug.set(slug, nextIdx);
    return next;
  };

  const indexFor = (slug: string): number => {
    const existing = indexBySlug.get(slug);
    if (existing !== undefined) return existing;
    // Force registration via colorFor side-effect
    colorFor(slug);
    return indexBySlug.get(slug) ?? 0;
  };

  return {
    showSessionStatus(message: string): void {
      write(`${sanitizeSingleLine(message)}\n`);
    },

    showPrompt(): void {
      write(chalk.bold(PROMPT_PREFIX));
    },

    showUserMessage(content: string): void {
      write(`${chalk.bold(PROMPT_PREFIX)}${sanitizeSingleLine(content)}\n`);
    },

    startExpertResponse(expertSlug: string): void {
      const rawName = experts.get(expertSlug) ?? expertSlug;
      const displayName = sanitizeSingleLine(rawName);
      const color = colorFor(expertSlug);
      const prefix = formatExpertPrefix(indexFor(expertSlug), displayName);
      write(`${color(`${prefix} > `)}`);
    },

    streamChunk(text: string): void {
      write(sanitizeMultiline(text));
    },

    endExpertResponse(): void {
      write("\n");
    },

    showSystem(message: string, level: "info" | "warn" | "error" = "info"): void {
      const safe = sanitizeSingleLine(message);
      switch (level) {
        case "info":
          write(`${chalk.blue("ℹ")} ${safe}\n`);
          return;
        case "warn":
          write(`${chalk.yellow("⚠")} ${safe}\n`);
          return;
        case "error":
          writeError(`${chalk.red("✗")} ${safe}\n`);
          return;
      }
    },

    showSeparator(): void {
      write(`${chalk.dim("─".repeat(40))}\n`);
    },
  };
}

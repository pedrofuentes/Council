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

import type { Sink } from "./types.js";

/**
 * Color palette for expert names. Mirrors the cyan accent used by
 * `PlainRenderer` and extends it with companion hues so multi-expert
 * panels remain distinguishable. Cycled modulo length when a panel
 * has more experts than colors.
 */
const EXPERT_COLORS: readonly ChalkInstance[] = [
  chalk.cyan,
  chalk.magenta,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.red,
  chalk.cyanBright,
  chalk.magentaBright,
] as const;

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

  // Pre-compute slug → color from registration order so color assignment
  // is deterministic across multiple renderer instances given the same map.
  const colorBySlug = new Map<string, ChalkInstance>();
  let index = 0;
  for (const slug of experts.keys()) {
    const color = EXPERT_COLORS[index % EXPERT_COLORS.length];
    if (color) colorBySlug.set(slug, color);
    index += 1;
  }

  const write = (text: string): void => sink.write(text);
  const writeError = (text: string): void => {
    if (sink.writeError) sink.writeError(text);
    else sink.write(text);
  };

  const colorFor = (slug: string): ChalkInstance => {
    const existing = colorBySlug.get(slug);
    if (existing) return existing;
    // Unknown slug — assign next color in cycle so subsequent calls stay stable.
    const next =
      EXPERT_COLORS[colorBySlug.size % EXPERT_COLORS.length] ?? EXPERT_COLORS[0] ?? chalk.cyan;
    colorBySlug.set(slug, next);
    return next;
  };

  return {
    showSessionStatus(message: string): void {
      write(`${stripControlChars(message)}\n`);
    },

    showPrompt(): void {
      write(chalk.bold.white(PROMPT_PREFIX));
    },

    showUserMessage(content: string): void {
      write(`${chalk.bold.white(PROMPT_PREFIX)}${stripControlChars(content)}\n`);
    },

    startExpertResponse(expertSlug: string): void {
      const rawName = experts.get(expertSlug) ?? expertSlug;
      const displayName = stripControlChars(rawName);
      const color = colorFor(expertSlug);
      write(`${color(`${displayName} > `)}`);
    },

    streamChunk(text: string): void {
      write(stripControlChars(text));
    },

    endExpertResponse(): void {
      write("\n");
    },

    showSystem(message: string, level: "info" | "warn" | "error" = "info"): void {
      const safe = stripControlChars(message);
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

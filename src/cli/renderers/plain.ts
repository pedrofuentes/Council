/**
 * Plain-text human-readable renderer.
 *
 * Streams `turn.delta` text immediately so users see expert responses
 * appear as they're generated. Headers, separators, and errors get
 * optional ANSI color via `chalk` when `color: true` (which is the
 * default for TTY consumers).
 *
 * Designed to gracefully degrade to plain ASCII when `color: false`,
 * so output captured in logs / pipes stays readable.
 */
import { Chalk, type ChalkInstance } from "chalk";

import type { DebateEvent, PanelMemberSnapshot } from "../../core/types.js";

import type { Renderer, Sink } from "./types.js";

export interface PlainRendererOptions {
  /** Whether to emit ANSI color codes. Defaults to true; tests pass false. */
  readonly color?: boolean;
}

export class PlainRenderer implements Renderer {
  readonly #sink: Sink;
  readonly #color: boolean;
  /**
   * Forced chalk instance — `level: 1` (basic 16-color) explicitly overrides
   * chalk's TTY auto-detection, which would otherwise return level 0 (no
   * color) in test runners or when stdout is piped. Real terminals get the
   * full color level; consumers who want true color can pipe through their
   * preferred terminal.
   */
  readonly #chalk: ChalkInstance;
  /** displayName lookup for prettier turn.start headers. */
  readonly #displayNames = new Map<string, string>();
  /** Track which slugs are human participants. */
  readonly #humanSlugs = new Set<string>();

  constructor(sink: Sink, options: PlainRendererOptions = {}) {
    this.#sink = sink;
    this.#color = options.color ?? true;
    this.#chalk = new Chalk({ level: this.#color && !process.env.NO_COLOR ? 1 : 0 });
  }

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    for await (const evt of events) {
      switch (evt.kind) {
        case "panel.assembled":
          this.renderPanelAssembled(evt.experts);
          break;
        case "round.start":
          this.write(`\n${this.bold(`━━━ Round ${evt.round + 1} ━━━`)}\n`);
          break;
        case "turn.start": {
          const name = this.#displayNames.get(evt.expertSlug) ?? evt.expertSlug;
          const isHuman = evt.speakerKind === "human" || this.#humanSlugs.has(evt.expertSlug);
          const label = isHuman ? `[You] ${name}` : name;
          this.write(`\n${this.cyan(`[${label}]`)}\n`);
          break;
        }
        case "turn.delta":
          this.write(evt.text);
          break;
        case "turn.end":
          this.write("\n");
          break;
        case "round.end":
          this.write(`\n${this.dim("─".repeat(40))}\n`);
          break;
        case "cost.update":
          this.write(
            `${this.gray(`[Cost: ${evt.premiumRequests}/${evt.estimatedTotal} premium requests]`)}\n`,
          );
          break;
        case "debate.end":
          this.write(`\n${this.bold(`--- Debate complete (${evt.reason}) ---`)}\n`);
          break;
        case "error":
          this.writeError(
            this.red(
              `[error${evt.expertSlug ? ` from ${evt.expertSlug}` : ""}]: ${evt.message}` +
                (evt.recoverable ? " (recoverable)" : ""),
            ) + "\n",
          );
          break;
      }
    }
  }

  private renderPanelAssembled(experts: readonly PanelMemberSnapshot[]): void {
    this.write(`\n${this.bold("🏛️  Panel assembled:")}\n`);
    for (const expert of experts) {
      this.#displayNames.set(expert.slug, expert.displayName);
      if (expert.participantKind === "human") {
        this.#humanSlugs.add(expert.slug);
        this.write(`  • ${expert.displayName} ${this.gray("(human)")}\n`);
      } else {
        this.write(`  • ${expert.displayName} ${this.gray(`(${expert.model})`)}\n`);
      }
    }
  }

  private write(text: string): void {
    this.#sink.write(text);
  }

  private writeError(text: string): void {
    if (this.#sink.writeError) this.#sink.writeError(text);
    else this.#sink.write(text);
  }

  // ---------- color helpers (no-op when color is disabled) ----------

  private bold(text: string): string {
    return this.#chalk.bold(text);
  }
  private cyan(text: string): string {
    return this.#chalk.cyan(text);
  }
  private dim(text: string): string {
    return this.#chalk.dim(text);
  }
  private gray(text: string): string {
    return this.#chalk.gray(text);
  }
  private red(text: string): string {
    return this.#chalk.red(text);
  }
}

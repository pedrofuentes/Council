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

import type { DebateEvent, DebatePhase, PanelMemberSnapshot } from "../../core/types.js";

import { friendlyReason } from "./friendly-reasons.js";
import { assignExpertColor, formatExpertPrefix } from "./ink/colors.js";
import { getSymbols } from "./symbols.js";
import type { Renderer, Sink } from "./types.js";
import { stripControlChars } from "../strip-control-chars.js";

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
  /** Track expert → 0-based index for color and prefix assignment. */
  readonly #expertIndex = new Map<string, number>();
  /** Current debate phase (for synthesis styling). */
  #currentPhase: DebatePhase | undefined = undefined;

  constructor(sink: Sink, options: PlainRendererOptions = {}) {
    this.#sink = sink;
    this.#color = options.color ?? true;
    this.#chalk = new Chalk({ level: this.#color && !process.env.NO_COLOR ? 1 : 0 });
  }

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    const sym = getSymbols();
    for await (const evt of events) {
      switch (evt.kind) {
        case "panel.assembled":
          this.renderPanelAssembled(evt.experts, sym.panel, sym.bullet);
          break;
        case "round.start":
          this.#currentPhase = evt.phase;
          this.write(
            `\n${this.bold(`${sym.roundRule.repeat(3)} Round ${evt.round + 1} ${sym.roundRule.repeat(3)}`)}\n`,
          );
          break;
        case "turn.start": {
          const name = this.#displayNames.get(evt.expertSlug) ?? evt.expertSlug;
          const isHuman = evt.speakerKind === "human" || this.#humanSlugs.has(evt.expertSlug);
          const isSynthesis = this.#currentPhase === "synthesis";
          const idx = this.#expertIndex.get(evt.expertSlug) ?? 0;
          const prefix = formatExpertPrefix(idx, name);
          if (isSynthesis) {
            const synthPrefix = `${sym.synthesis} [Synthesis] ${prefix}`;
            this.write(`\n${this.yellow(synthPrefix)}\n`);
          } else {
            const label = isHuman ? `[You] ${prefix}` : prefix;
            this.write(`\n${this.colorForExpert(evt.expertSlug)(`[${label}]`)}\n`);
          }
          break;
        }
        case "turn.delta":
          this.write(evt.text);
          break;
        case "turn.end":
          this.write("\n");
          break;
        case "round.end":
          {
            const width = Math.min(process.stdout.columns ?? 80, 100);
            this.write(`\n${this.dim(sym.separator.repeat(width))}\n`);
          }
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
                (evt.recoverable ? " — retrying automatically" : ""),
            ) + "\n",
          );
          break;
        case "turn.retry":
          this.write(
            this.gray(
              `[retry] ${evt.expertSlug} attempt ${evt.attempt}: ${this.sanitizeLine(friendlyReason(evt.reason))}\n`,
            ),
          );
          break;
      }
    }
  }

  private renderPanelAssembled(
    experts: readonly PanelMemberSnapshot[],
    panelIcon: string,
    bullet: string,
  ): void {
    this.write(`\n${this.bold(`${panelIcon}  Panel assembled:`)}\n`);
    experts.forEach((expert, i) => {
      this.#displayNames.set(expert.slug, expert.displayName);
      this.#expertIndex.set(expert.slug, i);
      const prefix = formatExpertPrefix(i, expert.displayName);
      if (expert.participantKind === "human") {
        this.#humanSlugs.add(expert.slug);
        this.write(`  ${bullet} ${prefix} ${this.gray("(human)")}\n`);
      } else {
        this.write(`  ${bullet} ${prefix} ${this.gray(`(${expert.model})`)}\n`);
      }
    });
  }

  private write(text: string): void {
    this.#sink.write(text);
  }

  private writeError(text: string): void {
    if (this.#sink.writeError) this.#sink.writeError(text);
    else this.#sink.write(text);
  }

  // ---------- color helpers (no-op when color is disabled) ----------

  /** Sanitize untrusted single-line text for terminal display. */
  private sanitizeLine(text: string): string {
    return stripControlChars(text).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ");
  }

  private colorForExpert(slug: string): (text: string) => string {
    const idx = this.#expertIndex.get(slug) ?? 0;
    const isHuman = this.#humanSlugs.has(slug);
    const colorName = assignExpertColor(idx, { isHuman });
    const fn = this.#chalk[colorName];
    return (text: string) => fn(text);
  }

  private bold(text: string): string {
    return this.#chalk.bold(text);
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
  private yellow(text: string): string {
    return this.#chalk.yellow(text);
  }
}

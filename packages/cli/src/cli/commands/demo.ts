/**
 * `council demo` — a zero-setup, deterministic showcase of a Council panel
 * deliberation.
 *
 * Runs a short, pre-scripted debate on a fixed sample topic using a built-in
 * panel and the in-memory {@link MockEngine}. It requires NO Copilot login,
 * NO API keys, NO network access, and writes NOTHING to the local database —
 * so a brand-new user can see Council's value in a single command:
 *
 *   council demo
 *
 * Determinism: the MockEngine returns the pre-scripted {@link DEMO_SCRIPT}
 * lines verbatim (keyed by a fixed per-persona id), so the transcript is
 * stable and the command is safe to assert on in tests. The deliberation is
 * scripted, so the demo intentionally takes no `[topic]` argument — it always
 * showcases {@link DEMO_TOPIC}.
 *
 * The command reuses the same engine seam (`CouncilEngine`), debate
 * orchestrator (`Debate`), and renderers (`selectRenderer`) that `convene`
 * and `ask` use, so the showcase reflects the real product.
 */
import { Command, Option } from "commander";

import { Debate, type DebateConfig } from "../../core/debate.js";
import type { ExpertDefinition } from "../../core/expert.js";
import { loadTemplate } from "../../core/template-loader.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { MockEngine } from "../../engine/mock/mock-engine.js";

import { PlainRenderer } from "../renderers/plain.js";
import { RENDERER_FORMATS, selectRenderer, type RendererFormat } from "../renderers/select.js";
import type { Sink } from "../renderers/types.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

/** Built-in panel (ships in `packages/cli/panels`) reused for the demo. */
export const DEMO_PANEL = "startup-validation";

/** Fixed sample topic the demo panel deliberates on. */
export const DEMO_TOPIC =
  "Should we launch a freemium AI code-review tool for mid-market engineering teams?";

/**
 * Cosmetic model label shown next to each persona in the transcript. No real
 * model is ever contacted — the demo runs entirely on the in-memory engine.
 */
const DEMO_MODEL = "claude-sonnet-4.5";

/** A single round keeps the showcase short ("a few expert turns"). */
const DEMO_MAX_ROUNDS = 1;
const DEMO_MAX_WORDS = 250;

/**
 * Pre-scripted expert responses keyed by the persona slug from
 * {@link DEMO_PANEL}. The MockEngine returns these verbatim so the transcript
 * reads like a real deliberation while staying fully deterministic offline.
 *
 * Keyed by slug (not engine id) so it survives any future persona renames in
 * the built-in panel: an unmatched slug simply falls back to the MockEngine's
 * deterministic stub rather than breaking the demo.
 */
export const DEMO_SCRIPT: Readonly<Record<string, string>> = {
  vc: "The market is real but crowded, so the only number I care about is payback period. Freemium can work if the free tier is a wedge, not a gift — convert on team seats and CI minutes, not on nag screens. Show me net revenue retention above 120% and I lean in; below that, this is a feature, not a company.",
  customer:
    "As the buyer, my worry isn't the model quality — it's procurement and adoption. If I have to file a security review and a data-handling questionnaire just to trial it, the free tier is irrelevant. Make it self-serve, keep our code on our infra, and prove value inside one sprint, or my team quietly stops opening the PR comments.",
  competitor:
    "We already sell into this segment, so here's the candid take: review tools don't churn on accuracy, they churn on noise. If your bot comments on every diff, engineers mute it in a week. Win on signal-to-noise and a painless GitHub install, and you'll take share we can't defend.",
  distribution:
    "Distribution decides this, not the tech. Bottom-up means your free tier IS the marketing budget: it has to be generous enough to spread in open-source and side projects, but stingy enough that a real team upgrades. Anchor on a per-developer price the market already understands, and instrument activation — install to first useful review — as your one north-star metric.",
};

/** Deterministic engine id for a demo persona slug (keys {@link DEMO_SCRIPT}). */
function demoExpertId(slug: string): string {
  return `demo-${slug}`;
}

/** Map the slug-keyed {@link DEMO_SCRIPT} onto MockEngine's id-keyed responses. */
function demoResponsesById(): Record<string, string> {
  const responses: Record<string, string> = {};
  for (const [slug, text] of Object.entries(DEMO_SCRIPT)) {
    responses[demoExpertId(slug)] = text;
  }
  return responses;
}

/**
 * Construct the demo's engine: an in-memory {@link MockEngine} seeded with the
 * pre-scripted responses. Exposed so callers and tests can confirm the demo
 * never instantiates a network-backed (Copilot) engine.
 */
export function createDemoEngine(): CouncilEngine {
  return new MockEngine({ responses: demoResponsesById() });
}

/**
 * Build the deterministic expert specs from the reused built-in panel.
 * Ids are fixed (not random ULIDs) so the scripted responses always match,
 * and the model label is a constant so the transcript is config-independent.
 */
function buildDemoExperts(panelExperts: readonly ExpertDefinition[]): ExpertSpec[] {
  return panelExperts.map((def) => ({
    id: demoExpertId(def.slug),
    slug: def.slug,
    displayName: def.displayName,
    model: DEMO_MODEL,
    systemMessage: `Demo persona: ${def.displayName} (offline showcase — no model is contacted).`,
  }));
}

function formatDemoIntro(): string {
  return (
    "Council demo — an offline showcase. No Copilot login, API key, or network needed.\n" +
    "A built-in panel deliberates a fixed topic using canned responses:\n\n" +
    `  Topic: ${DEMO_TOPIC}\n`
  );
}

function formatDemoNextSteps(): string {
  return (
    "\nThat's a Council panel. Now run one on YOUR topic:\n" +
    '  Try:   council convene "Should we migrate our monolith to microservices?"\n' +
    "  Setup: council doctor   (connect Copilot, then use convene / ask / chat)\n"
  );
}

export interface DemoCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
  /**
   * Test seam to observe or override engine creation. MUST return an offline
   * engine — the demo is network-free by contract. Defaults to
   * {@link createDemoEngine}.
   */
  readonly engineFactory?: () => CouncilEngine;
}

interface DemoRunOptions {
  readonly format: RendererFormat;
  readonly write: Writer;
  readonly writeError: Writer;
  readonly engineFactory: () => CouncilEngine;
  readonly isTTY: boolean;
}

/**
 * Run the scripted demo deliberation end-to-end: load the built-in panel,
 * register its personas with the offline engine, stream the debate through
 * the chosen renderer, and print a one-line pointer to real usage.
 *
 * Human framing (intro + next-steps pointer) is written only in text modes so
 * that `--format json` stdout stays pure NDJSON.
 */
async function runDemo(opts: DemoRunOptions): Promise<void> {
  const panel = await loadTemplate(DEMO_PANEL);
  const experts = buildDemoExperts(panel.experts);
  const engine = opts.engineFactory();

  const debateConfig: DebateConfig = {
    maxRounds: DEMO_MAX_ROUNDS,
    maxWordsPerResponse: DEMO_MAX_WORDS,
    mode: "freeform",
  };
  const isJson = opts.format === "json";

  try {
    await engine.start();

    // Register the canary-augmented specs (same ids) so scripted responses
    // still resolve, matching how convene/ask register debate.experts.
    const debate = new Debate(engine, experts, debateConfig);
    await Promise.all(debate.experts.map((expert) => engine.addExpert(expert)));

    const sink: Sink = { write: opts.write, writeError: opts.writeError };
    const renderer = selectRenderer({
      format: opts.format,
      isTTY: opts.isTTY,
      sink,
      showCost: false,
    });

    // The plain preamble is for the PlainRenderer only (Ink and JSON manage
    // their own framing) — mirror convene's preamble gating.
    if (renderer instanceof PlainRenderer) {
      opts.write(formatDemoIntro());
    }

    await renderer.render(debate.run(DEMO_TOPIC));

    if (!isJson) {
      opts.write(formatDemoNextSteps());
    }
  } finally {
    await engine.stop();
  }
}

export function buildDemoCommand(deps: DemoCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;
  const engineFactory = deps.engineFactory ?? createDemoEngine;

  const cmd = new Command("demo");
  cmd
    .description(
      "Run a zero-setup, offline showcase debate (no login, keys, or network) to see Council in one command",
    )
    .addOption(
      new Option(
        "--format <kind>",
        "Output format (auto picks Ink TUI on TTY, plain text otherwise)",
      )
        .choices([...RENDERER_FORMATS])
        .default("auto"),
    )
    .action(async (options: { readonly format: RendererFormat }) => {
      await runDemo({
        format: options.format,
        write,
        writeError,
        engineFactory,
        isTTY: Boolean(process.stdout.isTTY),
      });
    });

  return cmd;
}

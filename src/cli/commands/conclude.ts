/**
 * `council conclude [panel] --engine <kind> [--format json|plain]`
 * (ROADMAP §2.7)
 *
 * Reads the latest debate transcript for a panel and runs a single
 * synthesis prompt through the engine to produce a structured decision
 * framework.
 *
 * The synthesis is NOT a debate turn — it's a moderator/system call
 * using its own LLM invocation against a temporary "synthesizer"
 * expert. Nothing is persisted to the panel; conclude is a one-shot
 * read + project, identical in spirit to `export` but with an LLM in
 * the middle.
 *
 * Flow:
 *   1. Resolve the target panel (positional arg, or default to most
 *      recent in the local DB).
 *   2. `loadTranscript()` to read the panel + experts + latest debate
 *      + turns.
 *   3. Build a synthesis prompt that lists the topic and every expert
 *      turn, then ask the engine for JSON matching the
 *      `ConcludeOutput` schema.
 *   4. Register a transient synthesizer expert on the engine, send
 *      the prompt, accumulate deltas, then stop the engine.
 *   5. Parse the response (tolerating ```json``` fences) and validate
 *      it. Render to stdout as plain or JSON.
 */
import * as path from "node:path";

import { Command } from "commander";
import { ulid } from "ulid";
import { z } from "zod";

import { DEFAULT_MODEL, getCouncilHome } from "../../config/index.js";
import {
  type CouncilEngine,
  type EngineEvent,
  type ExpertSpec,
} from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import {
  loadTranscript,
  type TranscriptDocument,
} from "../../memory/transcript.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import {
  ENGINE_KINDS,
  type EngineKind,
  makeEngineFromKind,
} from "../run-with-engine.js";
import { formatEngineError } from "../error-mapper.js";

export const CONCLUDE_FORMATS = ["plain", "json"] as const;
export type ConcludeFormat = (typeof CONCLUDE_FORMATS)[number];

export interface DecisionDimensionPosition {
  readonly expert: string;
  readonly stance: string;
}

export interface DecisionDimension {
  readonly dimension: string;
  readonly positions: readonly DecisionDimensionPosition[];
}

export interface ConcludeOutput {
  readonly panelName: string;
  readonly topic: string;
  readonly consensus: readonly string[];
  readonly tensions: readonly string[];
  readonly decisionMatrix: readonly DecisionDimension[];
  readonly recommendation: string;
  readonly confidence: "high" | "medium" | "low";
}

const PositionSchema = z.object({
  expert: z.string(),
  stance: z.string(),
});

const DimensionSchema = z.object({
  dimension: z.string(),
  positions: z.array(PositionSchema),
});

const SynthesisSchema = z.object({
  consensus: z.array(z.string()),
  tensions: z.array(z.string()),
  decisionMatrix: z.array(DimensionSchema),
  recommendation: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

export const SYNTHESIS_SYSTEM_PROMPT = `You are a deliberation synthesizer. Analyze the expert panel discussion below and produce a structured decision framework.

Output valid JSON matching this schema:
{ "consensus": string[], "tensions": string[], "decisionMatrix": [{ "dimension": string, "positions": [{ "expert": string, "stance": string }] }], "recommendation": string, "confidence": "high"|"medium"|"low" }

Rules:
- consensus: only include points where ALL experts genuinely agree
- tensions: identify specific disagreements, not generic differences
- decisionMatrix: extract 3-5 key dimensions the experts weighed differently
- recommendation: synthesize a clear, actionable recommendation
- confidence: "high" if strong consensus, "low" if deep unresolved tensions

Respond with the JSON object only — no commentary, no markdown fences.`;

export interface ConcludeCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  /** Test-only seam: pin the synthesizer expert id for response seeding. */
  readonly synthesizerId?: string;
}

interface ConcludeRawOptions {
  readonly engine: EngineKind;
  readonly format?: string;
}

export function buildConcludeCommand(deps: ConcludeCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("conclude");
  cmd
    .description(
      "Synthesize the latest debate of a panel into a structured decision framework",
    )
    .argument(
      "[panel]",
      "Panel name to conclude (defaults to the most recently created panel)",
    )
    .requiredOption(
      "--engine <kind>",
      `Engine kind: ${ENGINE_KINDS.join(" | ")}`,
    )
    .option(
      "--format <kind>",
      `Output format: ${CONCLUDE_FORMATS.join(" | ")}`,
      "plain",
    )
    .action(async (panelArg: string | undefined, raw: ConcludeRawOptions) => {
      if (!ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${ENGINE_KINDS.join(", ")}`,
        );
      }
      const format: ConcludeFormat =
        raw.format === "json" ? "json" : "plain";

      if (raw.engine === "mock") {
        writeError(
          "\n!! [MOCK ENGINE] conclude running with deterministic offline mock — synthesis is NOT real.\n\n",
        );
      }

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelName = await resolvePanelName(db, panelArg);
        const doc = await loadTranscript(db, panelName);

        if (doc.turns.length === 0) {
          throw new Error(
            `Panel '${panelName}' has no turns in its latest debate — nothing to conclude. Run \`council convene\` or \`council resume --continue\` first.`,
          );
        }

        const engine = deps.engineFactory
          ? deps.engineFactory()
          : makeEngineFromKind(raw.engine);
        const synthesizerId = deps.synthesizerId ?? ulid();
        const synthesizerSpec: ExpertSpec = {
          id: synthesizerId,
          slug: "synthesizer",
          displayName: "Council Synthesizer",
          model: DEFAULT_MODEL,
          systemMessage: SYNTHESIS_SYSTEM_PROMPT,
        };

        let raw_response: string;
        try {
          await engine.start();
          await engine.addExpert(synthesizerSpec);
          const prompt = buildSynthesisPrompt(doc);
          raw_response = await collectResponse(
            engine,
            synthesizerId,
            prompt,
          );
        } catch (err: unknown) {
          writeError("\n" + formatEngineError(err as Error) + "\n\n");
          throw err;
        } finally {
          await engine.stop().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            writeError(
              `!! engine.stop() failed during cleanup: ${msg}\n`,
            );
          });
        }

        const parsed = parseSynthesisResponse(raw_response);
        const output: ConcludeOutput = {
          panelName,
          topic: doc.panel.topic ?? doc.latestDebate.prompt,
          consensus: parsed.consensus,
          tensions: parsed.tensions,
          decisionMatrix: parsed.decisionMatrix,
          recommendation: parsed.recommendation,
          confidence: parsed.confidence,
        };

        if (format === "json") {
          write(JSON.stringify(output, null, 2) + "\n");
        } else {
          write(renderPlain(output));
        }
      } finally {
        await db.destroy().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
        });
      }
    });

  return cmd;
}

async function resolvePanelName(
  db: Awaited<ReturnType<typeof createDatabase>>,
  panelArg: string | undefined,
): Promise<string> {
  if (panelArg !== undefined && panelArg.length > 0) return panelArg;
  const panels = await new PanelRepository(db).findAll();
  if (panels.length === 0) {
    throw new Error(
      "No panels found in the local database. Run `council convene` first.",
    );
  }
  // PanelRepository.findAll() orders by id ASC. Panel ids are ULIDs
  // (lexicographically time-sortable), so the last entry is the most
  // recently created.
  const latest = panels[panels.length - 1];
  if (!latest) {
    throw new Error(
      "No panels found in the local database. Run `council convene` first.",
    );
  }
  return latest.name;
}

export function buildSynthesisPrompt(doc: TranscriptDocument): string {
  const nameById = new Map<string, string>();
  for (const e of doc.experts) nameById.set(e.id, e.displayName);

  const lines: string[] = [];
  const topic = doc.panel.topic ?? doc.latestDebate.prompt;
  lines.push(`Topic: ${topic}`);
  lines.push("");
  lines.push("Panel members:");
  for (const e of doc.experts) {
    lines.push(`  - ${e.displayName} (${e.slug})`);
  }
  lines.push("");
  lines.push("Debate transcript:");
  for (const t of doc.turns) {
    const speaker = t.expertId
      ? (nameById.get(t.expertId) ?? t.speakerKind)
      : t.speakerKind;
    lines.push(`[${speaker}] (round ${t.round}, seq ${t.seq}):`);
    lines.push(t.content);
    lines.push("");
  }
  lines.push(
    "Now produce the JSON synthesis as instructed in your system message. Output only JSON.",
  );
  return lines.join("\n");
}

async function collectResponse(
  engine: CouncilEngine,
  expertId: string,
  prompt: string,
): Promise<string> {
  const buf: string[] = [];
  let errorMessage: string | undefined;
  for await (const ev of engine.send({ expertId, prompt }) as AsyncIterable<EngineEvent>) {
    if (ev.kind === "message.delta") {
      buf.push(ev.text);
    } else if (ev.kind === "error") {
      errorMessage = `${ev.error.code}: ${ev.error.message}`;
    }
  }
  if (errorMessage !== undefined) {
    throw new Error(`Engine returned error during synthesis: ${errorMessage}`);
  }
  return buf.join("");
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/i;

export function parseSynthesisResponse(raw: string): z.infer<typeof SynthesisSchema> {
  const trimmed = raw.trim();
  let candidate = trimmed;
  const fence = FENCE_RE.exec(trimmed);
  if (fence?.[1]) {
    candidate = fence[1].trim();
  } else if (!trimmed.startsWith("{")) {
    // Try to find the first { ... } block in free-form text.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      candidate = trimmed.slice(start, end + 1);
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse synthesizer response as JSON: ${msg}. Raw response: ${truncate(raw, 200)}`,
    );
  }
  const result = SynthesisSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `Synthesizer response did not match expected schema: ${result.error.message}`,
    );
  }
  return result.data;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

function renderPlain(out: ConcludeOutput): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Council Decision Framework ===");
  lines.push("");
  lines.push(`Panel: ${out.panelName}`);
  lines.push(`Topic: ${out.topic}`);
  lines.push("");

  lines.push("Consensus:");
  if (out.consensus.length === 0) {
    lines.push("  (none identified)");
  } else {
    for (const c of out.consensus) lines.push(`  - ${c}`);
  }
  lines.push("");

  lines.push("Tensions:");
  if (out.tensions.length === 0) {
    lines.push("  (none identified)");
  } else {
    for (const t of out.tensions) lines.push(`  - ${t}`);
  }
  lines.push("");

  lines.push("Decision Matrix:");
  if (out.decisionMatrix.length === 0) {
    lines.push("  (no dimensions identified)");
  } else {
    for (const d of out.decisionMatrix) {
      lines.push(`  * ${d.dimension}`);
      for (const p of d.positions) {
        lines.push(`      - ${p.expert}: ${p.stance}`);
      }
    }
  }
  lines.push("");

  lines.push(`Recommendation: ${out.recommendation}`);
  lines.push(`Confidence: ${out.confidence}`);
  lines.push("");
  return lines.join("\n");
}

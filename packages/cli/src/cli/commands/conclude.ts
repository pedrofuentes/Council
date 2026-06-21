/**
 * `council conclude [panel] --engine <kind> [--format json|plain]`
 * (ROADMAP §2.7)
 *
 * Reads the selected debate transcript for a panel and runs a single
 * synthesis prompt through the engine to produce a structured decision
 * framework.
 */
import * as path from "node:path";

import { Command, Option } from "commander";

import { getCouncilHome, loadConfig, resolveEngine } from "../../config/index.js";
import type { CouncilEngine } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { loadTranscript } from "../../memory/transcript.js";
import {
  buildSynthesisPrompt,
  CONCLUDE_FORMATS,
  type ConcludeFormat,
  type ConcludeOutput,
  formatTruncationWarning,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_TURNS,
  parseSynthesisResponse,
  renderPlain,
  SynthesisSchemaError,
  SynthesisUnparseableError,
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_TIMEOUT_MS,
  synthesizeConclusion,
  type BuiltSynthesisPrompt,
  type DecisionDimension,
  type DecisionDimensionPosition,
  type SynthesisParseResult,
} from "../conclusion-synthesis.js";

import { CliUserError } from "../cli-user-error.js";
import { formatEngineError } from "../error-mapper.js";
import { EXIT_USER_ERROR, exitCodeForEngineError } from "../exit-codes.js";
import { ENGINE_KINDS, type EngineKind, makeEngineFromKind } from "../run-with-engine.js";
import { resolveSession } from "../session-resolver.js";
import { defaultErrorWriter, defaultNoticeWriter, defaultWriter, type Writer } from "./writer.js";

export {
  buildSynthesisPrompt,
  CONCLUDE_FORMATS,
  formatTruncationWarning,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_TURNS,
  parseSynthesisResponse,
  renderPlain,
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_TIMEOUT_MS,
};
export type {
  BuiltSynthesisPrompt,
  ConcludeFormat,
  ConcludeOutput,
  DecisionDimension,
  DecisionDimensionPosition,
  SynthesisParseResult,
};

export interface ConcludeCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  readonly writeNotice?: Writer;
  /** Test-only seam: pin the synthesizer expert id for response seeding. */
  readonly synthesizerId?: string;
}

interface ConcludeRawOptions {
  readonly engine?: EngineKind;
  readonly format?: string;
  readonly timeout?: number;
  readonly model?: string;
}

export function buildConcludeCommand(deps: ConcludeCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;
  const writeNotice: Writer = deps.writeNotice ?? defaultNoticeWriter;

  const cmd = new Command("conclude");
  cmd
    .description(
      "Synthesize a panel's most substantive debate into a structured decision framework. " +
        "For transcript-based ADR (Architecture Decision Record) export, use `council export --format adr` instead.",
    )
    .argument("[panel]", "Panel name to conclude (defaults to the most recently created panel)")
    .addOption(
      new Option("--engine <kind>", "Engine kind (default: from config)").choices([
        ...ENGINE_KINDS,
      ]),
    )
    .addOption(
      new Option("--format <kind>", "Output format")
        .choices([...CONCLUDE_FORMATS])
        .default("plain"),
    )
    .option(
      "--timeout <ms>",
      "Synthesis timeout in milliseconds",
      (v) => {
        if (!/^\d+$/.test(v)) {
          throw new Error(`Invalid timeout value: "${v}" — must be a positive integer.`);
        }
        const n = Number.parseInt(v, 10);
        if (n <= 0 || n > 2_147_483_647) {
          throw new Error(
            `Invalid timeout value: "${v}" — must be a positive integer (max 2147483647).`,
          );
        }
        return n;
      },
      SYNTHESIS_TIMEOUT_MS,
    )
    .option("--model <model>", "Model to use for synthesis (default: from config)")
    .action(async (panelArg: string | undefined, raw: ConcludeRawOptions) => {
      const format: ConcludeFormat = raw.format === "json" ? "json" : "plain";

      const config = await loadConfig();
      const resolvedEngine = resolveEngine(raw.engine, config);

      if (resolvedEngine === "mock") {
        writeNotice(
          "\n!! [MOCK ENGINE] conclude running with deterministic offline mock — synthesis is NOT real.\n\n",
        );
      }
      const councilHome = getCouncilHome();
      const dbPath = path.join(councilHome, "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelName = await resolveSession({
          db,
          dataHome: councilHome,
          panelArg,
          writeError,
          missingPanelMode: "most-recently-debated",
        });
        const doc = await loadTranscript(db, panelName);

        if (doc.turns.length === 0) {
          throw new Error(
            `Panel '${panelName}' has no turns in its selected debate — nothing to conclude. ` +
              `Run \`council convene "${doc.panel.topic ?? "<topic>"}" --template ${panelName} --engine copilot\` or ` +
              `\`council resume ${panelName} --prompt "<prompt>" --engine copilot\` first.`,
          );
        }

        const engine = deps.engineFactory
          ? deps.engineFactory()
          : makeEngineFromKind(resolvedEngine);
        let output: ConcludeOutput;
        try {
          await engine.start();
          output = await synthesizeConclusion({
            doc,
            panelName,
            engine,
            model: raw.model ?? config.defaults.model,
            maxTranscriptChars: config.conclude.maxTranscriptChars,
            ...(raw.timeout !== undefined ? { timeoutMs: raw.timeout } : {}),
            ...(deps.synthesizerId !== undefined ? { synthesizerId: deps.synthesizerId } : {}),
          });
        } catch (err: unknown) {
          if (err instanceof SynthesisSchemaError) {
            throw err;
          }
          if (err instanceof SynthesisUnparseableError) {
            writeError("\n" + err.message + "\n\n");
            const cliErr = new CliUserError(err.message);
            cliErr.exitCode = EXIT_USER_ERROR;
            throw cliErr;
          }
          writeError("\n" + formatEngineError(err as Error) + "\n\n");
          const cliErr = new CliUserError(err instanceof Error ? err.message : String(err));
          cliErr.exitCode = exitCodeForEngineError((err as { code?: string }).code);
          throw cliErr;
        } finally {
          await engine.stop().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            writeError(`!! engine.stop() failed during cleanup: ${msg}\n`);
          });
        }

        if (format === "json") {
          write(JSON.stringify(output, null, 2) + "\n");
        } else {
          write(renderPlain(output));
          write(
            `\x1b[2mNext: council export ${panelName} --format adr  (Architecture Decision Record)\x1b[0m\n`,
          );
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

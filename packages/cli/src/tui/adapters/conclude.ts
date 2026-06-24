import {
  synthesizeConclusion,
  type ConcludeOutput,
  type DecisionDimension,
} from "../../cli/conclusion-synthesis.js";
import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { CouncilEngine } from "../../engine/index.js";
import type { TranscriptDocument } from "../../memory/transcript.js";

/** A single expert's position on one decision dimension, sanitized for display. */
export interface ConclusionStance {
  readonly expert: string;
  readonly stance: string;
}

/** One row of the decision matrix: a dimension and every expert's stance on it. */
export interface ConclusionDimension {
  readonly dimension: string;
  readonly stances: readonly ConclusionStance[];
}

/**
 * The engine-backed conclusion, with every untrusted (model-generated) string
 * already collapsed to a single display line. Renderers may pass these fields
 * straight to an Ink `<Text>`/`ScrollView` sink without further sanitization.
 */
export interface ConclusionView {
  readonly panelName: string;
  readonly topic: string;
  readonly consensus: readonly string[];
  readonly tensions: readonly string[];
  readonly decisionMatrix: readonly ConclusionDimension[];
  readonly recommendation: string;
  readonly confidence: "high" | "medium" | "low";
  readonly warnings: readonly string[];
}

export interface ConcludeSynthesizeOptions {
  /** Abort the in-flight synthesis (e.g. the screen unmounts or the user cancels). */
  readonly signal?: AbortSignal;
  /** Conclude a specific debate instead of the panel's most substantive one. */
  readonly debateId?: string;
}

export interface ConcludeDataSource {
  synthesize(panelName: string, options?: ConcludeSynthesizeOptions): Promise<ConclusionView>;
}

export interface ConcludeDeps {
  readonly engineFactory: () => CouncilEngine;
  readonly loadTranscript: (panelName: string, debateId?: string) => Promise<TranscriptDocument>;
  readonly model: string;
  readonly maxTranscriptChars: number;
}

export function createConcludeSource(deps: ConcludeDeps): ConcludeDataSource {
  return {
    async synthesize(
      panelName: string,
      options: ConcludeSynthesizeOptions = {},
    ): Promise<ConclusionView> {
      const doc = await deps.loadTranscript(panelName, options.debateId);
      const engine = deps.engineFactory();
      try {
        await engine.start();
        const output = await withAbort(
          synthesizeConclusion({
            doc,
            panelName,
            engine,
            model: deps.model,
            maxTranscriptChars: deps.maxTranscriptChars,
          }),
          options.signal,
        );
        return toConclusionView(output);
      } finally {
        // A cleanup failure must never replace the synthesis result or error
        // (mirrors the conclude command + convene adapter). Swallow rejections.
        await engine.stop().catch(() => undefined);
      }
    },
  };
}

/**
 * Reject `work` as soon as `signal` aborts, otherwise settle with `work`.
 * Used so a long synthesis stops blocking the screen the moment the user
 * cancels or navigates away; the caller's `finally` still stops the engine.
 */
async function withAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return work;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

function abortError(): Error {
  return new Error("Conclusion synthesis was cancelled");
}

function toConclusionView(output: ConcludeOutput): ConclusionView {
  return {
    panelName: toSingleLineDisplay(output.panelName),
    topic: toSingleLineDisplay(output.topic),
    consensus: output.consensus.map(toSingleLineDisplay),
    tensions: output.tensions.map(toSingleLineDisplay),
    decisionMatrix: output.decisionMatrix.map(toDimensionView),
    recommendation: toSingleLineDisplay(output.recommendation),
    confidence: output.confidence,
    warnings: (output.warnings ?? []).map(toSingleLineDisplay),
  };
}

function toDimensionView(dimension: DecisionDimension): ConclusionDimension {
  return {
    dimension: toSingleLineDisplay(dimension.dimension),
    stances: dimension.positions.map((position) => ({
      expert: toSingleLineDisplay(position.expert),
      stance: toSingleLineDisplay(position.stance),
    })),
  };
}

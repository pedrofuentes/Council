/**
 * ScriptedEngine — a CouncilEngine test double whose `send()` returns a
 * *different* scripted response on each successive call for the same
 * expert. Unlike {@link MockEngine} (whose `responses` map is static per
 * expertId), this lets a test prove behavior that depends on the engine
 * returning, e.g., an empty response first and a populated one on retry.
 *
 * A step is either streamed content (one delta + a clean
 * `message.complete`) or a terminal `error` event. An empty `content`
 * step yields no delta — an exact analogue of an expert that completes
 * without producing any text.
 */
import type {
  CouncilEngine,
  EngineErrorCode,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../src/engine/index.js";

export type ScriptStep =
  | { readonly kind: "content"; readonly text: string }
  | {
      readonly kind: "error";
      readonly code: EngineErrorCode;
      readonly message: string;
      readonly recoverable: boolean;
    };

export interface ScriptedEngineOptions {
  /** expertId → ordered responses; one consumed per `send()` call. */
  readonly scripts: Readonly<Record<string, readonly ScriptStep[]>>;
  /** Response used once a script is exhausted/absent. Defaults to non-empty content. */
  readonly fallback?: ScriptStep;
}

export class ScriptedEngine implements CouncilEngine {
  /** Every `send()` call, in temporal order (for call-count assertions). */
  readonly sends: SendOptions[] = [];
  readonly #scripts: Readonly<Record<string, readonly ScriptStep[]>>;
  readonly #fallback: ScriptStep;
  readonly #counts = new Map<string, number>();
  readonly #experts = new Set<string>();

  constructor(options: ScriptedEngineOptions) {
    this.#scripts = options.scripts;
    this.#fallback = options.fallback ?? { kind: "content", text: "[scripted fallback]" };
  }

  /** Number of `send()` calls received for a given expert id. */
  sendCount(expertId: string): number {
    return this.#counts.get(expertId) ?? 0;
  }

  async start(): Promise<void> {
    /* no-op */
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.add(spec.id);
  }

  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }

  async listModels(): Promise<readonly string[]> {
    return ["scripted"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push(options);
    const n = this.#counts.get(options.expertId) ?? 0;
    this.#counts.set(options.expertId, n + 1);
    const steps = this.#scripts[options.expertId] ?? [];
    const step = steps[n] ?? this.#fallback;
    const expertId = options.expertId;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        if (step.kind === "error") {
          yield {
            kind: "error",
            expertId,
            error: { code: step.code, message: step.message },
            recoverable: step.recoverable,
          };
          return;
        }
        if (step.text.length > 0) {
          yield { kind: "message.delta", expertId, text: step.text };
        }
        yield { kind: "message.complete", expertId, response: { latencyMs: 1 } };
      },
    };
  }
}

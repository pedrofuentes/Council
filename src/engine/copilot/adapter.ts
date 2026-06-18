/**
 * Copilot SDK adapter — the ONLY file in the project that imports
 * `@github/copilot-sdk`. Enforced by ESLint `no-restricted-imports`
 * and AGENTS.md §Boundaries (Council-specific NEVER).
 *
 * Implements `CouncilEngine` over the Copilot SDK:
 *   - One `CopilotClient` per engine instance, multiplexing N sessions.
 *   - One session per registered expert, primed with their full system prompt.
 *   - Translates SDK events to Council's domain `EngineEvent` stream.
 *   - Maps SDK errors to the stable `EngineErrorCode` union via a small
 *     classifier (see `classifyError` below).
 *   - Honors the cancellation contract from `CouncilEngine`: AbortSignal,
 *     `stop()`, and `removeExpert()` all yield terminal `ABORTED`.
 *
 * Lifecycle: `start()` calls `client.start()`; `stop()` disconnects every
 * session then calls `client.stop()`. Both are idempotent.
 */
import { CopilotClient, type CopilotSession, type PermissionRequest } from "@github/copilot-sdk";

import type {
  CouncilEngine,
  EngineError,
  EngineErrorCode,
  EngineEvent,
  EngineResponse,
  ExpertSpec,
  SendOptions,
} from "../index.js";
import { SUPPORTED_MODELS } from "../models.js";

import { denyAll } from "./permissions.js";

/**
 * Provider health probe — verifies the Copilot SDK is loadable and exposes
 * the symbols Council depends on, WITHOUT starting a client or making any
 * network call. Exposed here (not in a sibling file) because the ESLint
 * boundary rule restricts `@github/copilot-sdk` imports to this single file.
 *
 * Used by `council doctor` via `src/engine/copilot/health.ts`.
 */
export interface ProviderHealth {
  readonly ok: boolean;
  readonly detail: string;
}

export function pingProviderHealth(): ProviderHealth {
  try {
    if (typeof CopilotClient !== "function") {
      return {
        ok: false,
        detail:
          "@github/copilot-sdk is loaded but CopilotClient export is missing — version mismatch?",
      };
    }
    return {
      ok: true,
      detail: "@github/copilot-sdk loaded; CopilotClient export present",
    };
  } catch (err: unknown) {
    return {
      ok: false,
      detail: `cannot probe @github/copilot-sdk: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ModelDiscoveryResult {
  readonly models: readonly string[];
  readonly source: "live" | "static";
}

const STATIC_MODEL_LIST = (Object.isFrozen(SUPPORTED_MODELS)
  ? SUPPORTED_MODELS
  : Object.freeze(SUPPORTED_MODELS)) as readonly string[];

function freezeDiscoveredModels(models: readonly { readonly id: string }[]): readonly string[] {
  return Object.freeze(models.map(({ id }) => id)) as readonly string[];
}

export async function discoverAvailableModels(): Promise<ModelDiscoveryResult> {
  let client: CopilotClient | undefined;
  try {
    client = new CopilotClient();
    await client.start();
    return {
      models: freezeDiscoveredModels(await client.listModels()),
      source: "live",
    };
  } catch {
    return { models: STATIC_MODEL_LIST, source: "static" };
  } finally {
    try {
      await client?.stop();
    } catch {
      /* best effort cleanup */
    }
  }
}

interface ExpertRecord {
  readonly spec: ExpertSpec;
  readonly session: CopilotSession;
  /** AbortControllers for each in-flight send so removeExpert() can abort them. */
  readonly inFlight: Set<AbortController>;
}

/**
 * Concrete implementation of `CouncilEngine` over `@github/copilot-sdk`.
 */
export class CopilotEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertRecord>();
  #client: CopilotClient | undefined;
  #started = false;
  #stopped = false;
  #lastStopErrors: Error[] = [];
  #modelListCache: readonly string[] | undefined;

  /**
   * Errors collected during the most recent `stop()` invocation.
   *
   * Backwards-compatible read-after-stop accessor introduced for #143:
   * `stop()` still returns `Promise<void>`, but per-session disconnect
   * failures (and the final `client.stop()` failure) are now collected
   * here instead of being silently swallowed. Operationally important —
   * a populated array means a server-side session may be leaking and ops
   * should investigate. Empty after a clean stop.
   */
  get lastStopErrors(): readonly Error[] {
    return this.#lastStopErrors;
  }

  async start(): Promise<void> {
    if (this.#started && !this.#stopped) return;
    this.#client = new CopilotClient();
    await this.#client.start();
    this.#started = true;
    this.#stopped = false;
    this.#lastStopErrors = [];
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    const errors: Error[] = [];
    // Abort every in-flight send across every expert.
    for (const record of this.#experts.values()) {
      for (const ctrl of record.inFlight) ctrl.abort();
      try {
        await record.session.disconnect();
      } catch (err: unknown) {
        // #143: collect rather than swallow. A disconnect failure can
        // mean the session is leaking server-side; ops needs to see it.
        errors.push(
          err instanceof Error
            ? new Error(`expert ${record.spec.id}: ${err.message}`, { cause: err })
            : new Error(`expert ${record.spec.id}: ${String(err)}`),
        );
      }
    }
    this.#experts.clear();
    if (this.#client) {
      try {
        await this.#client.stop();
      } catch (err: unknown) {
        errors.push(
          err instanceof Error
            ? new Error(`CopilotClient.stop(): ${err.message}`, { cause: err })
            : new Error(`CopilotClient.stop(): ${String(err)}`),
        );
      }
    }
    this.#client = undefined;
    this.#stopped = true;
    this.#lastStopErrors = errors;
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    if (!this.#client) {
      throw new Error("CopilotEngine: start() must be called before addExpert()");
    }
    if (this.#experts.has(spec.id)) {
      throw new Error(`Expert ${spec.id} is already registered`);
    }
    // Wrap our domain-typed denyAll into the shape the SDK expects.
    // Council's contract is that we deny everything; the SDK uses
    // PermissionDecisionReject with kind: "reject" to express denial.
    const sdkDenyAll = async (_request: PermissionRequest): Promise<{ kind: "reject" }> => {
      // Run our domain-level handler for telemetry/inspection symmetry.
      await denyAll({ toolName: _request.kind });
      return { kind: "reject" };
    };
    const session = await this.#client.createSession({
      model: spec.model,
      systemMessage: { content: spec.systemMessage },
      onPermissionRequest: sdkDenyAll,
      // Council experts answer from their system prompt + injected
      // [REFERENCE DOCUMENTS]; they are never offered SDK tools. An empty
      // allow-list removes the default toolset entirely, so the model no
      // longer narrates "I have no tools" or "let me check your working
      // directory" (denying at call time still left the tools advertised).
      availableTools: [],
    });
    this.#experts.set(spec.id, { spec, session, inFlight: new Set() });
  }

  async removeExpert(expertId: string): Promise<void> {
    const record = this.#experts.get(expertId);
    if (!record) return; // idempotent no-op
    for (const ctrl of record.inFlight) ctrl.abort();
    try {
      await record.session.disconnect();
    } catch {
      /* ignore */
    }
    this.#experts.delete(expertId);
  }

  async listModels(): Promise<readonly string[]> {
    if (this.#modelListCache) {
      return this.#modelListCache;
    }
    if (!this.#client || !this.#started || this.#stopped) {
      return STATIC_MODEL_LIST;
    }
    try {
      const discoveredModels = freezeDiscoveredModels(await this.#client.listModels());
      this.#modelListCache = discoveredModels;
      return this.#modelListCache;
    } catch {
      return STATIC_MODEL_LIST;
    }
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    const record = this.#experts.get(options.expertId);
    if (!record) {
      throw new Error(`Expert ${options.expertId} is not registered`);
    }
    const controller = new AbortController();
    record.inFlight.add(controller);

    let removeCallerListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeCallerListener = (): void => options.signal?.removeEventListener("abort", onAbort);
      }
    }

    return this.#stream(record, options.expertId, options.prompt, controller, removeCallerListener);
  }

  async *#stream(
    record: ExpertRecord,
    expertId: string,
    prompt: string,
    controller: AbortController,
    removeCallerListener: (() => void) | undefined,
  ): AsyncGenerator<EngineEvent, void, void> {
    const start = Date.now();
    // Tracks unsubscribers for any SDK listeners registered below; drained
    // in the finally block so long chats don't accumulate handlers (#479).
    const unsubscribes: (() => void)[] = [];
    try {
      // Pre-aborted check.
      if (controller.signal.aborted) {
        yield {
          kind: "error",
          expertId,
          error: {
            code: "ABORTED",
            message: "Send was aborted before invocation",
            provider: "copilot",
          },
          recoverable: false,
        };
        return;
      }

      // Buffer to enqueue events from SDK callbacks; consumer drains via yield.
      const queue: EngineEvent[] = [];
      let done = false;
      let terminatedByError = false;
      let waker: (() => void) | undefined;
      function push(evt: EngineEvent): void {
        queue.push(evt);
        if (evt.kind === "error") terminatedByError = true;
        waker?.();
      }
      function finish(): void {
        done = true;
        waker?.();
      }

      const onDelta = (evt: { data: { deltaContent: string } }): void => {
        const text = evt.data?.deltaContent ?? "";
        if (text.length > 0) {
          push({ kind: "message.delta", expertId, text });
        }
      };
      // SDK v0.3.0 sends complete responses via assistant.message instead
      // of streaming deltas. Emit as a single message.delta so downstream
      // consumers (debate, chat) accumulate content identically.
      const onMessage = (evt: { data: { content: string } }): void => {
        const text = evt.data?.content ?? "";
        if (text.length > 0) {
          push({ kind: "message.delta", expertId, text });
        }
      };
      const onIdle = (): void => {
        finish();
      };
      const onError = (evt: { data: { message?: string } }): void => {
        const error = classifyError(evt.data?.message ?? "unknown SDK error");
        push({ kind: "error", expertId, error, recoverable: isRecoverable(error.code) });
        finish();
      };

      // Track unsubscribers so we can release SDK listeners in finally (#479).
      // Without this, every send() would leak handlers on the long-lived session.
      unsubscribes.push(record.session.on("assistant.message_delta", onDelta));
      unsubscribes.push(record.session.on("assistant.message", onMessage));
      unsubscribes.push(record.session.on("session.idle", onIdle));
      unsubscribes.push(record.session.on("session.error", onError));

      const onAbort = (): void => {
        // Cancel the underlying SDK request so the provider stops generating
        // for an interrupted turn. The SDK `send()` promise stays pending for
        // the whole request, so without this the model keeps streaming to
        // completion in the background after Ctrl+C. Best-effort and not
        // awaited: the consumer is already returning to the prompt, and any
        // rejection (e.g. the session was disconnected) is irrelevant here.
        void record.session.abort().catch(() => undefined);
        push({
          kind: "error",
          expertId,
          error: { code: "ABORTED", message: "Send was aborted", provider: "copilot" },
          recoverable: false,
        });
        finish();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      // Kick off the send asynchronously; thrown errors map to terminal error event.
      const sendPromise = (async () => {
        try {
          await record.session.send({ prompt });
        } catch (err: unknown) {
          const error = classifyError(err instanceof Error ? err.message : String(err), err);
          push({ kind: "error", expertId, error, recoverable: isRecoverable(error.code) });
          finish();
        }
      })();

      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          const evt = queue.shift();
          if (evt) yield evt;
          continue;
        }
        await new Promise<void>((resolve) => {
          waker = resolve;
        });
        waker = undefined;
      }

      // Only emit synthetic message.complete if no error/abort already terminated.
      if (!terminatedByError) {
        yield {
          kind: "message.complete",
          expertId,
          response: {
            latencyMs: Date.now() - start,
          } satisfies EngineResponse,
        };
      }

      // Ensure the send promise resolves (errors already handled in its catch).
      await sendPromise;
    } finally {
      for (const unsub of unsubscribes) {
        try {
          unsub();
        } catch {
          /* ignore — best-effort cleanup */
        }
      }
      record.inFlight.delete(controller);
      removeCallerListener?.();
    }
  }
}

/**
 * Map SDK error messages / objects to our stable EngineErrorCode set.
 * Heuristic; better mapping happens when a real adapter integration test
 * pins the exact error shapes the SDK throws.
 */
function classifyError(message: string, cause?: unknown): EngineError {
  const lower = message.toLowerCase();
  let code: EngineErrorCode;
  if (lower.includes("abort") || lower.includes("cancel")) {
    code = "ABORTED";
  } else if (lower.includes("auth") || lower.includes("unauthor") || lower.includes("login")) {
    code = "NOT_AUTHENTICATED";
  } else if (lower.includes("rate") || lower.includes("quota") || lower.includes("limit")) {
    code = "RATE_LIMITED";
  } else if (lower.includes("model") && (lower.includes("not") || lower.includes("unavailable"))) {
    code = "MODEL_UNAVAILABLE";
  } else if (lower.includes("context") || lower.includes("token limit")) {
    code = "CONTEXT_OVERFLOW";
  } else if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn")) {
    code = "NETWORK";
  } else {
    code = "PROVIDER_ERROR";
  }
  return { code, message, cause, provider: "copilot" };
}

function isRecoverable(code: EngineErrorCode): boolean {
  return code === "RATE_LIMITED" || code === "NETWORK";
}

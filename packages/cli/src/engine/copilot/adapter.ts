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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";

import { denyAll } from "./permissions.js";

/**
 * Cap for diagnostic messages echoed to the terminal. Mirrors the 200-char
 * bound used by the chat layer's `sanitizeErrorMessage()` so engine
 * diagnostics can't flood or garble the TTY.
 */
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 200;

/**
 * Render an untrusted/opaque error as a single-line, control-char-free, bounded
 * string safe to interpolate into a terminal diagnostic (`console.warn`). SDK
 * and transport errors can carry multi-line, ANSI-laden, or very long messages;
 * this collapses them to one sanitized line and truncates to
 * {@link MAX_DIAGNOSTIC_MESSAGE_LENGTH}. Part of the terminal-output
 * sanitization program (#668, #416, #1134, #1155).
 */
function sanitizeDiagnosticMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = toSingleLineDisplay(raw).trim();
  return oneLine.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? `${oneLine.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 3)}...`
    : oneLine;
}

/**
 * Provider health probe — verifies the Copilot SDK's *export surface* is
 * present and well-formed, WITHOUT starting a client or making any network
 * call. Exposed here (not in a sibling file) because the ESLint boundary rule
 * restricts `@github/copilot-sdk` imports to this single file.
 *
 * NOTE (#96): `@github/copilot-sdk` is now statically imported, so a module
 * *load* failure aborts this whole file before the probe can run — it can no
 * longer certify "module loadable" (the previous try/catch was dead code for
 * that case). What it certifies instead is that the `CopilotClient` symbol
 * Council binds to is present as a constructor, which still catches an
 * installed-but-incompatible SDK whose export was dropped or changed shape
 * (version drift).
 *
 * Used by `council doctor` via `src/engine/copilot/health.ts`.
 */
export interface ProviderHealth {
  readonly ok: boolean;
  readonly detail: string;
}

export function pingProviderHealth(): ProviderHealth {
  if (typeof CopilotClient !== "function") {
    return {
      ok: false,
      detail:
        "@github/copilot-sdk export surface incomplete: CopilotClient is not a constructor — version mismatch?",
    };
  }
  return {
    ok: true,
    detail: "@github/copilot-sdk export surface present: CopilotClient constructor available",
  };
}

export interface ModelDiscoveryResult {
  readonly models: readonly string[];
  readonly source: "live" | "static";
}

/** Options for {@link discoverAvailableModels}. */
export interface ModelDiscoveryOptions {
  /**
   * Upper bound (ms) on live SDK discovery (`client.start()` + `listModels()`).
   * On timeout, discovery falls back to the static model list instead of
   * hanging (#721). Defaults to {@link DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
}

/** Default {@link ModelDiscoveryOptions.timeoutMs}: bound a stalled SDK (#721). */
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Resolve the absolute path to the `@github/copilot` CLI entry that
 * `@github/copilot-sdk` spawns.
 *
 * The SDK's own resolver (`getBundledCliPath`) assumes `@github/copilot`
 * exposes an `index.js` / `./sdk` export, but `@github/copilot` >= 1.0.4x is a
 * bin-only loader package (`npm-loader.js`, no `index.js`/`exports`). The SDK
 * therefore computes a bogus path and fails with "Copilot CLI not found". We
 * read the CLI's own `bin` entry from its `package.json`, resolving it relative
 * to the SDK so it works under both hoisted (npm global) and nested (pnpm)
 * `node_modules` layouts. Returns `undefined` if anything can't be resolved.
 */
export function resolveCopilotCliPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const sdkDir = dirname(require.resolve("@github/copilot-sdk"));
    const cliPackageJsonPath = require.resolve("@github/copilot/package.json", {
      paths: [sdkDir],
    });
    const cliPackage = JSON.parse(readFileSync(cliPackageJsonPath, "utf8")) as {
      readonly bin?: string | Record<string, string>;
    };
    const binEntry = typeof cliPackage.bin === "string" ? cliPackage.bin : cliPackage.bin?.copilot;
    if (binEntry === undefined) {
      return undefined;
    }
    return join(dirname(cliPackageJsonPath), binEntry);
  } catch {
    return undefined;
  }
}

/**
 * Point the Copilot SDK at the resolved CLI via its sanctioned
 * `COPILOT_CLI_PATH` override, unless the caller already set it. Idempotent and
 * best-effort: if the CLI can't be resolved, the SDK's default resolution is
 * left untouched. Call before constructing a {@link CopilotClient}.
 */
export function ensureCopilotCliPath(): void {
  const existing = process.env.COPILOT_CLI_PATH;
  if (existing !== undefined && existing !== "") {
    return;
  }
  const resolved = resolveCopilotCliPath();
  if (resolved !== undefined) {
    process.env.COPILOT_CLI_PATH = resolved;
  }
}

const STATIC_MODEL_LIST = (
  Object.isFrozen(SUPPORTED_MODELS) ? SUPPORTED_MODELS : Object.freeze(SUPPORTED_MODELS)
) as readonly string[];

function freezeDiscoveredModels(models: readonly { readonly id: string }[]): readonly string[] {
  return Object.freeze(models.map(({ id }) => id)) as readonly string[];
}

class ModelDiscoveryTimeoutError extends Error {
  constructor(ms: number) {
    super(`SDK model discovery timed out after ${ms}ms`);
    this.name = "ModelDiscoveryTimeoutError";
  }
}

/**
 * Race `promise` against a timeout, rejecting with {@link ModelDiscoveryTimeoutError}
 * if the deadline elapses first. Always clears the timer. The underlying SDK
 * call cannot be truly cancelled, so callers must still tear the client down
 * (the `finally` in {@link discoverAvailableModels} does) to release resources.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ModelDiscoveryTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function discoverAvailableModels(
  options?: ModelDiscoveryOptions,
): Promise<ModelDiscoveryResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
  let client: CopilotClient | undefined;
  try {
    ensureCopilotCliPath();
    const c = new CopilotClient();
    client = c;
    // #721: bound start() + listModels() so a stalled SDK can't hang callers.
    //
    // #1899 caveat — SUBPROCESS LIFETIME: withTimeout() bounds only the
    // *caller's* wait. The raced IIFE below is not cancellable: `c.start()`
    // spawns the `@github/copilot` CLI subprocess via the SDK, and neither
    // start() nor listModels() accepts an AbortSignal. On timeout we fall back
    // to the static list and the `finally` issues a best-effort `client.stop()`,
    // but the SDK does not guarantee stop() reaps a child that has not finished
    // starting — so the spawned binary may live until its own I/O round-trip
    // completes. For a single-shot `doctor`/startup call this is immaterial (the
    // child is reaped on process exit); callers that invoke discovery in a
    // RETRY LOOP should space calls out to avoid accumulating unreaped children
    // and pressuring OS process/fd limits. Full fix needs an upstream
    // `@github/copilot-sdk` cancellation/kill path (AbortSignal or stop({force})).
    const models = await withTimeout(
      (async (): Promise<readonly string[]> => {
        await c.start();
        return freezeDiscoveredModels(await c.listModels());
      })(),
      timeoutMs,
    );
    return { models, source: "live" };
  } catch (err: unknown) {
    // #719: never fall back silently — a downgraded (static) model list is an
    // operationally meaningful event (stale/missing tiers), so surface it.
    console.warn(
      `[council/engine] model discovery failed; falling back to ${STATIC_MODEL_LIST.length} built-in models: ${sanitizeDiagnosticMessage(err)}`,
    );
    return { models: STATIC_MODEL_LIST, source: "static" };
  } finally {
    // #741: surface cleanup failures instead of discarding them — a failed
    // client.stop() can mean a leaked SDK session that ops needs to see.
    try {
      await client?.stop();
    } catch (err: unknown) {
      console.warn(
        `[council/engine] model discovery cleanup failed (possible leaked SDK session): ${sanitizeDiagnosticMessage(err)}`,
      );
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
  /** Copilot bills premium requests — surface real cost metrics. */
  readonly supportsCostMetrics = true;

  readonly #experts = new Map<string, ExpertRecord>();
  #client: CopilotClient | undefined;
  #started = false;
  #stopped = false;
  #stopping: Promise<void> | undefined;
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
    ensureCopilotCliPath();
    this.#client = new CopilotClient();
    await this.#client.start();
    this.#started = true;
    this.#stopped = false;
    this.#lastStopErrors = [];
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    // #149: coalesce concurrent stop() calls. Without this, two overlapping
    // invocations both iterate #experts, double-abort in-flight controllers,
    // and double-call client.stop() (they only observe #stopped after every
    // await resolves). The initiator runs teardown once; re-entrant callers
    // await the same in-flight promise.
    if (this.#stopping !== undefined) {
      await this.#stopping;
      return;
    }
    const run = this.#runStop();
    this.#stopping = run;
    try {
      await run;
    } finally {
      this.#stopping = undefined;
    }
  }

  async #runStop(): Promise<void> {
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
      // The Copilot SDK may deliver a complete response as a single
      // assistant.message event instead of streaming assistant.message_delta
      // events. Emit it as one message.delta so downstream consumers
      // (debate, chat) accumulate content identically.
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
        void record.session.abort().catch((err: unknown) => {
          // Emit a non-secret diagnostic so a failed cancellation is observable
          // instead of silently swallowed (#1143). The ABORTED event is already
          // pushed above, so user-facing behavior is unchanged. Sanitize + bound
          // the message so a garbled/huge transport error can't flood or spoof
          // the terminal (#1155).
          console.warn(
            `[council/engine] session.abort() failed: ${sanitizeDiagnosticMessage(err)}`,
          );
        });
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
  } else if (lower.includes("context") || lower.includes("token limit")) {
    // Checked BEFORE RATE_LIMITED (#59): a context-overflow message such as
    // "token limit exceeded" also contains the substring "limit", so the
    // RATE_LIMITED branch below would otherwise shadow it and misclassify a
    // context overflow as a rate limit. Keep this branch above RATE_LIMITED.
    code = "CONTEXT_OVERFLOW";
  } else if (lower.includes("rate") || lower.includes("quota") || lower.includes("limit")) {
    code = "RATE_LIMITED";
  } else if (lower.includes("model") && (lower.includes("not") || lower.includes("unavailable"))) {
    code = "MODEL_UNAVAILABLE";
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

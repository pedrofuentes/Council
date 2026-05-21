/**
 * Map engine errors (and arbitrary thrown errors from the engine layer)
 * into actionable user-facing CLI messages (closes #133).
 *
 * Used by `convene` and `resume` action handlers. (`memory` doesn't
 * call the engine, so it doesn't need this mapper.) Each
 * `EngineErrorCode` maps to a hint that tells the user what to do
 * next ("run `gh auth login`", "check your connection", etc.) rather
 * than the raw provider message.
 *
 * The function accepts:
 *   - An `EngineError`-shaped object (`{code, message, ...}`) — preferred
 *   - A thrown `Error` (with optional `code` property) — fallback for
 *     synchronous throws from `engine.start()` etc. that haven't been
 *     wrapped into the structured shape yet.
 *
 * It always returns a non-empty string suitable for direct stderr
 * output. The underlying message is included verbatim for diagnostic
 * use so users can copy-paste into bug reports.
 */
import type { EngineError, EngineErrorCode } from "../engine/index.js";

interface ErrorLike {
  readonly code?: EngineErrorCode | string;
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly model?: string;
}

/**
 * Render a user-facing CLI error for an engine failure.
 *
 * Always returns a multi-line string ending with a newline-free
 * trailing message; callers append their own newline if needed.
 */
export function formatEngineError(input: EngineError | ErrorLike | Error): string {
  // Normalize: extract whatever fields we can find without trusting shape.
  let code: string | undefined;
  let message: string;
  let retryAfterMs: number | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  if (input instanceof Error) {
    // Thrown Error path — may have a tagged `code` we attached upstream,
    // otherwise fall through to the generic INTERNAL hint.
    const maybeCoded = input as Error & { code?: string; model?: string };
    code = maybeCoded.code;
    message = input.message;
    model = maybeCoded.model;
  } else {
    code = input.code;
    message = input.message ?? String(input);
    retryAfterMs = input.retryAfterMs;
    provider = input.provider;
    model = (input as ErrorLike).model;
  }

  const hint = hintForCode(code, { message, retryAfterMs, provider, model });
  return `${hint}\n\n  Underlying: ${message}`;
}

function hintForCode(
  code: string | undefined,
  ctx: {
    readonly message: string;
    readonly retryAfterMs?: number | undefined;
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
  },
): string {
  switch (code) {
    case "NOT_AUTHENTICATED":
      return (
        "Council couldn't authenticate with the engine. " +
        "Run `gh auth login` (and grant Copilot scope) and retry. " +
        "If you don't have `gh`, run `council doctor` for setup guidance.\n\n" +
        "💡 Run `council doctor` to diagnose your setup."
      );
    case "MODEL_UNAVAILABLE": {
      // Prefer the explicit model field; fall back to regex extraction.
      let model = ctx.model;
      if (!model) {
        const modelMatch = ctx.message.match(
          /[a-z][a-z0-9-]*-(?:opus|sonnet|haiku|gpt|gemini)[a-z0-9.-]*/i,
        );
        model = modelMatch ? modelMatch[0] : "(unknown)";
      }
      return (
        `Model ${model} isn't available on your Copilot tier. ` +
        "Check `council doctor` for the model list, or try a different `--model` flag on the expert."
      );
    }
    case "NETWORK":
      return (
        "Network error talking to the engine. " +
        "Check your connection / VPN / proxy and retry. " +
        "Council retries recoverable network failures up to 2× automatically; " +
        "if you're seeing this, all retries were exhausted."
      );
    case "RATE_LIMITED": {
      const back = ctx.retryAfterMs
        ? `Provider asked to wait ${Math.round(ctx.retryAfterMs / 1000)}s.`
        : "";
      return (
        "Rate limited by the engine. " +
        "Council retries with exponential backoff automatically; " +
        "if you're seeing this, all retries were exhausted. " +
        `Wait a moment and retry${back ? " — " + back : "."}`
      );
    }
    case "CONTEXT_OVERFLOW":
      return (
        "Prompt + history exceed the model's context window. " +
        "Try a smaller `--max-words`, fewer experts, or fewer rounds. " +
        "Long-running panels may need `council memory reset --yes` to start fresh."
      );
    case "ABORTED":
      return "Cancelled (stop requested).";
    case "INTERNAL":
      return (
        "Internal Council error — this is a bug. " +
        "Please file an issue at https://github.com/pedrofuentes/Council/issues with the message below."
      );
    case "PROVIDER_ERROR":
      return (
        `Engine provider${ctx.provider ? ` (${ctx.provider})` : ""} returned an unmapped error. ` +
        "If this persists, file an issue with the underlying message below so the adapter can be improved."
      );
    default:
      // No code — generic fallback. Keep the original message visible.
      return "Engine error.";
  }
}

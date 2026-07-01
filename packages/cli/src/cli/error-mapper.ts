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
import { toSingleLineDisplay } from "./strip-control-chars.js";

interface ErrorLike {
  readonly code?: EngineErrorCode | string;
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly provider?: string;
  readonly model?: string;
}

/**
 * Wrap a URL with OSC-8 escape sequences for clickable terminal hyperlinks.
 * Degrades gracefully to plain text on non-TTY or dumb terminals.
 *
 * @param url - The URL to link to
 * @param text - Display text (defaults to the URL itself)
 * @param stream - The output stream to check for TTY (defaults to stderr for error context)
 */
export function wrapLink(
  url: string,
  text?: string,
  stream: { isTTY?: boolean } = process.stderr,
): string {
  if (!stream.isTTY || process.env.TERM === "dumb") return text ?? url;
  return `\x1b]8;;${url}\x1b\\${text ?? url}\x1b]8;;\x1b\\`;
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
    // Thrown Error path — may have a tagged `code` we attached upstream.
    // When it doesn't (the common case for engine.start() lifecycle
    // failures from CopilotEngine), recover structure from the `cause`
    // chain before falling back to message inference in `hintForCode`
    // (#188).
    const maybeCoded = input as Error & {
      code?: string;
      model?: string;
      cause?: unknown;
    };
    code = maybeCoded.code;
    message = input.message;
    model = maybeCoded.model;
    if (code === undefined) {
      let fromCause: ErrorLike | undefined;
      try {
        fromCause = findEngineErrorInCause(maybeCoded.cause);
      } catch {
        // A throwing `cause` getter on the top-level Error (e.g. a Proxy trap)
        // must not break formatEngineError's always-returns contract; fall
        // through to message-based inference with `code` still undefined (#1911).
        fromCause = undefined;
      }
      if (fromCause) {
        code = fromCause.code;
        retryAfterMs = fromCause.retryAfterMs;
        provider = fromCause.provider;
        model = model ?? fromCause.model;
      }
    }
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
  // When no code was supplied (untagged Error), infer one from well-known
  // message substrings so the user still gets an actionable hint (#188).
  const resolvedCode = code ?? inferCodeFromMessage(ctx.message);
  switch (resolvedCode) {
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
        const modelMatch = ctx.message.match(/\b(?:claude|gpt|gemini)-[a-z0-9.-]+\b/i);
        model = modelMatch ? modelMatch[0] : "(unknown)";
      }
      // Sanitize before interpolating into stderr: a crafted model
      // identifier could otherwise smuggle ANSI/OSC escapes, C0 controls,
      // or CR/LF into the terminal (spoofing, title injection) (#668).
      const safeModel = toSingleLineDisplay(model);
      return (
        `Model ${safeModel} isn't available on your Copilot tier. ` +
        "Fix: council config set defaults.model <available-model>\n" +
        "Run 'council doctor --models' to see available models."
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
        `Please file an issue at ${wrapLink("https://github.com/pedrofuentes/Council/issues")} with the message below.`
      );
    case "PROVIDER_ERROR": {
      // Sanitize the provider label before interpolating into stderr: like the
      // `model` field above, a provider identifier recovered from an untrusted
      // error `cause` (or supplied on the structured shape) could otherwise
      // smuggle ANSI/OSC escapes, C0/C1 controls, or CR/LF into the terminal
      // (spoofing, title injection) (#1910). The `typeof` guard also keeps a
      // non-string provider from breaking the sanitizer boundary.
      const safeProvider =
        typeof ctx.provider === "string" ? toSingleLineDisplay(ctx.provider) : "";
      return (
        `Engine provider${safeProvider ? ` (${safeProvider})` : ""} returned an unmapped error. ` +
        "If this persists, file an issue with the underlying message below so the adapter can be improved."
      );
    }
    default:
      // No recognized code and no inferable signal — generic fallback.
      // Keep the original message visible for bug reports.
      return "Engine error.";
  }
}

/**
 * Walk an error's `cause` chain looking for the first EngineError-shaped
 * object (any object exposing a string `code`). Depth is bounded to guard
 * against cyclic `cause` references. Returns `undefined` when none is found.
 *
 * Property reads are wrapped in try/catch and the match is returned as a
 * trusted snapshot: an untrusted `cause` may expose an accessor that throws
 * (a Proxy trap or a lazily-computed wrapper), and such a throw must never
 * escape `formatEngineError`, whose contract is to always return a string
 * for stderr (#1911). Only well-typed fields are copied, so a throwing getter
 * on the caller's side is impossible.
 */
function findEngineErrorInCause(cause: unknown, depth = 0): ErrorLike | undefined {
  if (depth > 8 || cause === null || typeof cause !== "object") return undefined;
  try {
    const candidate = cause as {
      readonly code?: unknown;
      readonly cause?: unknown;
      readonly retryAfterMs?: unknown;
      readonly provider?: unknown;
      readonly model?: unknown;
    };
    if (typeof candidate.code === "string") {
      // Copy only well-typed fields, omitting undefined ones so the snapshot
      // satisfies ErrorLike under exactOptionalPropertyTypes.
      const retryAfterMs =
        typeof candidate.retryAfterMs === "number" ? candidate.retryAfterMs : undefined;
      const provider = typeof candidate.provider === "string" ? candidate.provider : undefined;
      const model = typeof candidate.model === "string" ? candidate.model : undefined;
      return {
        code: candidate.code,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
      };
    }
    return findEngineErrorInCause(candidate.cause, depth + 1);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort classification of an untagged error message into a known
 * `EngineErrorCode` by matching common provider/runtime substrings. Only
 * high-confidence auth/network/timeout signals are mapped; anything else
 * returns `undefined` so the caller keeps the generic fallback (#188).
 */
function inferCodeFromMessage(message: string): EngineErrorCode | undefined {
  const lower = message.toLowerCase();
  if (
    /\b(?:unauthenticated|unauthorized|not\s+authenticated|not\s+authorized|authentication|forbidden|401|403|invalid\s+token|missing\s+token|expired\s+token|credentials?|gh\s+auth|sign\s?in|log\s?in)\b/.test(
      lower,
    )
  ) {
    return "NOT_AUTHENTICATED";
  }
  if (
    /\b(?:network|offline|unreachable|dns|timed?\s*out|timeout|econnrefused|econnreset|enotfound|etimedout|eai_again|socket\s+hang\s+up|connection\s+(?:refused|reset|closed|failed|timed\s+out))\b/.test(
      lower,
    )
  ) {
    return "NETWORK";
  }
  return undefined;
}

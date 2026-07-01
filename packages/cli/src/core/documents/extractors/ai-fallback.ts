/**
 * AI-fallback extractor (T15).
 *
 * Last-resort extractor invoked when no native (extension-registered)
 * extractor handles a file. It is gated behind the
 * `documents.aiExtraction` configuration setting (`off` / `ask` /
 * `auto`) and a `documents.aiExtractionAllowedExtensions` whitelist.
 *
 * Crucially, this module does NOT call any AI API or import
 * `@github/copilot-sdk` — that import is restricted by ESLint to
 * `engine/copilot/adapter.ts` (see DECISIONS.md ADR-003). Instead, it
 * produces a structured *description* of the unsupported file (its
 * filename, size, extension, and a short magic-byte signature) so
 * higher layers can either:
 *   - present the description to the user (`mode = "ask"`), then re-run
 *     extraction with explicit consent, or
 *   - route the description through the engine adapter to a model that
 *     can interpret it (`mode = "auto"`), without this module ever
 *     touching the SDK directly.
 *
 * Security guard-rails:
 *   - A built-in extension blocklist rejects executables, archives that
 *     are already handled natively, common media formats, and database
 *     files regardless of `mode` or `allowedExtensions`. The blocklist
 *     ALWAYS wins.
 *   - The fallback never logs raw buffer content. Only extension, size,
 *     and the first eight magic bytes (in hex) ever appear in logs or
 *     error messages.
 *
 * Caching:
 *   - Callers may pass an injected cache (`Map<sha256, AiFallbackContent>`)
 *     to memoize results across repeat scans. The key is the SHA-256
 *     hex digest of the buffer's bytes; identical content always yields
 *     the same cached reference.
 */
import { createHash } from "node:crypto";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { DocumentMetadata, ExtractedContent, ExtractionContext } from "./types.js";

/**
 * Runtime configuration for the AI fallback. Mirrors the shape of the
 * `documents.aiExtraction` / `documents.aiExtractionAllowedExtensions`
 * settings in the user config schema.
 */
export interface AiFallbackConfig {
  readonly mode: "off" | "ask" | "auto";
  /**
   * Whitelist of extensions eligible for AI fallback. When empty, all
   * non-blocklisted extensions are eligible. Matching is
   * case-insensitive.
   */
  readonly allowedExtensions: readonly string[];
}

/**
 * Metadata produced by the AI fallback. Extends `DocumentMetadata` so
 * the result is structurally compatible with `ExtractedContent`, while
 * adding fields that describe how the fallback handled this file.
 */
export interface AiFallbackMetadata extends DocumentMetadata {
  /** Friendly description of the detected format (extension + signature hint). */
  readonly detectedFormat: string;
  /** Human-readable next-step suggestion for the caller / user. */
  readonly suggestedAction: string;
  /** Mode under which the fallback ran. */
  readonly mode: "ask" | "auto";
  /**
   * Set to `true` only when `mode === "ask"`, signalling that the
   * caller must obtain user confirmation before treating the result as
   * a real extraction. Omitted in `auto` mode.
   */
  readonly askUser?: boolean;
}

/**
 * Concrete fallback result type — narrower than `ExtractedContent`
 * because `metadata` is required and is `AiFallbackMetadata`.
 */
export type AiFallbackContent = Omit<ExtractedContent, "metadata"> & {
  readonly metadata: AiFallbackMetadata;
};

/**
 * Minimal logger surface for fallback observability. Mirrors the
 * pattern used by `DebatePersisterLogger` so callers can supply either
 * a console-backed logger or a Vitest mock without pulling in a full
 * logging library.
 */
export interface AiFallbackLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Optional dependencies. Both `cache` and `logger` are injected so
 * tests can observe behavior without module-level state. Production
 * callers (e.g. `extractor.ts`) own the cache so it can persist across
 * a scanning batch.
 */
export interface AiFallbackDeps {
  readonly cache?: Map<string, AiFallbackContent>;
  readonly logger?: AiFallbackLogger;
}

/**
 * Built-in blocklist. These extensions ALWAYS bypass the AI fallback,
 * even when explicitly listed in `allowedExtensions`:
 *   - Executables/scripts: huge attack surface; the AI surface should
 *     never be asked to "interpret" arbitrary code.
 *   - Archives that are already handled (zip/7z/rar/tar/gz): if the
 *     archive-aware extractor failed, falling back to AI on the raw
 *     archive bytes is unhelpful and risks unbounded memory use.
 *   - Media formats: text-extraction over images/audio/video is a
 *     fundamentally different problem and should be a separate feature.
 *   - Database files: opening on-disk databases here would race writers
 *     and produce inconsistent snapshots; a dedicated DB extractor is
 *     required.
 */
const BLOCKLIST: ReadonlySet<string> = new Set<string>([
  // executables / scripts
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".com",
  ".bat",
  ".cmd",
  ".sh",
  ".ps1",
  // archives already handled by native extractors
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  // media formats
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".svg",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  // database formats
  ".db",
  ".sqlite",
  ".sqlite3",
]);

const MAGIC_BYTES_LENGTH = 8;
const SHA_LOG_PREFIX_LENGTH = 8;
const MAX_FILENAME_LENGTH = 255;

function normalizeExtension(ext: string): string {
  return ext.toLowerCase();
}

/**
 * Per-config memo of the normalized `allowedExtensions` Set. Keyed by config
 * *reference* (a WeakMap, so an entry is collected once its config is), this
 * avoids rebuilding the Set on every call during a batch scan where the same
 * config object is reused (#984). Configs are treated as immutable, so a
 * reference hit always yields an equivalent set.
 */
const normalizedAllowedExtensionsCache = new WeakMap<AiFallbackConfig, ReadonlySet<string>>();

function normalizedAllowedExtensions(config: AiFallbackConfig): ReadonlySet<string> {
  const cached = normalizedAllowedExtensionsCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const normalized = new Set(config.allowedExtensions.map(normalizeExtension));
  normalizedAllowedExtensionsCache.set(config, normalized);
  return normalized;
}

/**
 * Collapse an untrusted filename to a single safe display line, then cap its
 * length. Delegates to {@link toSingleLineDisplay} — the shared terminal-sink
 * sanitizer — which strips C0/C1 controls, DEL, bidi override/isolate marks
 * (Trojan Source, CVE-2021-42574), zero-width and hidden format characters,
 * and collapses newlines, tabs and Unicode line/paragraph separators to a
 * single space. This stops untrusted filenames from injecting newlines,
 * tabs, or prompt-fragment text into the structured output. The length cap
 * then bounds oversized names.
 */
function sanitizeFilename(raw: string): string {
  const cleaned = toSingleLineDisplay(raw);
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_FILENAME_LENGTH) + "…";
}

/**
 * Produce a short hex string of the first N bytes of the buffer for
 * use in logs and the result's `content`. Only file *signature* bytes
 * are surfaced — never bulk content — so private user data does not
 * leak through audit logs.
 */
function magicByteSignature(buffer: Buffer, n: number = MAGIC_BYTES_LENGTH): string {
  const slice = buffer.subarray(0, Math.min(n, buffer.length));
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Map well-known signatures to a friendly format hint. This is a
 * deliberately small table — it is NOT a substitute for the magic-byte
 * detection in `registry.ts`, just a "for the user" hint when the
 * fallback runs. Returns `null` when no recognizable signature
 * matches.
 */
function detectKnownSignature(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    const b2 = buffer[2];
    const b3 = buffer[3];
    if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return "PDF document";
    if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return "ZIP-based container";
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return "PNG image";
    if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return "JPEG image";
    if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return "GIF image";
    if (b0 === 0x4d && b1 === 0x5a) return "Windows executable (MZ)";
    if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return "ELF executable";
  }
  if (buffer.length >= 5) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    const b2 = buffer[2];
    const b3 = buffer[3];
    const b4 = buffer[4];
    if (b0 === 0x7b && b1 === 0x5c && b2 === 0x72 && b3 === 0x74 && b4 === 0x66)
      return "Rich Text Format";
  }
  return null;
}

/**
 * Signatures that must ALWAYS be blocked regardless of file extension.
 * Mirrors the extension blocklist categories: executables and media.
 * This prevents renamed executables/images from reaching the AI surface.
 */
const SIGNATURE_BLOCKLIST: ReadonlySet<string> = new Set<string>([
  "Windows executable (MZ)",
  "ELF executable",
  "PNG image",
  "JPEG image",
  "GIF image",
]);

function describeFormat(extension: string, buffer: Buffer): string {
  const known = detectKnownSignature(buffer);
  if (known === null) {
    return `unknown (extension ${extension})`;
  }
  return `${known} (extension ${extension})`;
}

function countWords(text: string): number {
  // Count runs of non-whitespace directly rather than materializing the two
  // intermediate arrays that `split(/\s+/).filter(...)` allocates (#987).
  const wordPattern = /\S+/g;
  let count = 0;
  while (wordPattern.exec(text) !== null) {
    count += 1;
  }
  return count;
}

function buildSummary(
  ctx: ExtractionContext,
  detectedFormat: string,
  signature: string,
  mode: "ask" | "auto",
): string {
  const safeName = sanitizeFilename(ctx.filename);
  const lines: string[] = [
    `File ${safeName} (${ctx.sizeBytes} bytes, extension ${ctx.extension}) was not handled by any native extractor.`,
    `Detected format: ${detectedFormat}.`,
    `Magic-byte signature: ${signature}.`,
  ];
  if (mode === "ask") {
    lines.push("User confirmation is required before AI-based interpretation proceeds.");
  } else {
    lines.push(
      "Native extraction is unavailable; this description was produced by the AI-fallback stub.",
    );
  }
  return lines.join("\n");
}

function buildSuggestion(mode: "ask" | "auto", extension: string): string {
  if (mode === "ask") {
    return `Confirm AI-based extraction to interpret this ${extension} file, or convert it to a natively supported format.`;
  }
  return `Convert ${extension} to a natively supported format (e.g. .txt, .md, .pdf) for higher-fidelity extraction.`;
}

/**
 * Pure, extension-only eligibility check for the AI fallback's *review*
 * surfacing. Returns `true` when a file with the given `extension` would
 * be eligible for AI extraction under `config` — i.e. the mode is not
 * `off`, the extension is not blocklisted, and (when a non-empty
 * allowlist is configured) the extension is allowlisted.
 *
 * This is deliberately a SUBSET of the gates in {@link attemptAiFallback}:
 * it operates WITHOUT reading the file, so it omits the magic-byte
 * signature blocklist (which can only run once the bytes are in hand). It
 * exists so producers (the expert processor, the panel scanner) can flag
 * unsupported-EXTENSION files — which the detector drops before extraction
 * and therefore never have a buffer — as "awaiting AI-extraction review"
 * in `ask` mode WITHOUT performing, or implying, any extraction. The full
 * signature gate still applies later if/when the file is actually read and
 * extracted after explicit user confirmation.
 *
 * `BLOCKLIST` and `allowedExtensions` are the single source of truth here,
 * shared with {@link attemptAiFallback}, so the two paths can never drift.
 */
export function isExtensionAiEligible(extension: string, config: AiFallbackConfig): boolean {
  if (config.mode === "off") {
    return false;
  }
  const ext = normalizeExtension(extension);
  if (BLOCKLIST.has(ext)) {
    return false;
  }
  if (config.allowedExtensions.length > 0) {
    return normalizedAllowedExtensions(config).has(ext);
  }
  return true;
}

/**
 * Attempt the AI fallback. Returns `null` when the fallback is
 * disabled, the extension is blocklisted, or the extension is not in
 * the allowedExtensions whitelist. Otherwise returns an
 * `AiFallbackContent` describing the file.
 *
 * The function NEVER calls an AI API. The "content" string is a
 * structured human-readable description; callers may forward it to a
 * model via the engine adapter or surface it directly to the user.
 *
 * Resilience: this function never throws. A pre-aborted `ctx.signal`
 * short-circuits to `null` before hashing (respecting extraction
 * timeouts), and any unexpected internal error (e.g. a corrupted Buffer
 * whose hashing/slicing throws) is caught, logged as a warning, and
 * surfaced as `null` so the caller falls back to the original failure.
 */
export async function attemptAiFallback(
  ctx: ExtractionContext,
  config: AiFallbackConfig,
  deps: AiFallbackDeps = {},
): Promise<AiFallbackContent | null> {
  const ext = normalizeExtension(ctx.extension);
  const logger = deps.logger;

  try {
    if (config.mode === "off") {
      logger?.info(`ai-fallback: skipped (mode=off) extension=${ext} size=${ctx.sizeBytes}`);
      return null;
    }

    // Respect cooperative cancellation (e.g. extraction timeout) before
    // running SHA-256 over a potentially large buffer.
    if (ctx.signal?.aborted === true) {
      logger?.warn(`ai-fallback: aborted (cancelled) extension=${ext} size=${ctx.sizeBytes}`);
      return null;
    }

    if (BLOCKLIST.has(ext)) {
      logger?.info(`ai-fallback: skipped (blocklisted) extension=${ext} size=${ctx.sizeBytes}`);
      return null;
    }

    // Magic-byte signature gate: detect renamed executables/media that
    // bypass the extension blocklist.
    const signatureHint = detectKnownSignature(ctx.buffer);
    if (signatureHint !== null && SIGNATURE_BLOCKLIST.has(signatureHint)) {
      logger?.info(
        `ai-fallback: skipped (blocklisted signature) detected=${signatureHint} extension=${ext} size=${ctx.sizeBytes}`,
      );
      return null;
    }

    if (config.allowedExtensions.length > 0) {
      if (!normalizedAllowedExtensions(config).has(ext)) {
        logger?.info(`ai-fallback: skipped (not in allowedExtensions whitelist) extension=${ext}`);
        return null;
      }
    }

    const cache = deps.cache;
    // Only hash the buffer when a cache is actually wired — hashing a
    // potentially large buffer purely to key/log a digest we never store is
    // wasted CPU (#983).
    const sha =
      cache !== undefined ? createHash("sha256").update(ctx.buffer).digest("hex") : undefined;
    if (cache !== undefined && sha !== undefined) {
      const cached = cache.get(sha);
      if (cached !== undefined) {
        logger?.info(
          `ai-fallback: cache hit sha=${sha.slice(0, SHA_LOG_PREFIX_LENGTH)} extension=${ext}`,
        );
        return cached;
      }
    }

    logger?.info(
      `ai-fallback: attempted extension=${ext} size=${ctx.sizeBytes} mode=${config.mode}`,
    );

    const signature = magicByteSignature(ctx.buffer);
    const detectedFormat = describeFormat(ext, ctx.buffer);
    const mode: "ask" | "auto" = config.mode;
    const summary = buildSummary(ctx, detectedFormat, signature, mode);
    const suggestion = buildSuggestion(mode, ext);

    const metadata: AiFallbackMetadata =
      mode === "ask"
        ? {
            detectedFormat,
            suggestedAction: suggestion,
            mode,
            askUser: true,
          }
        : {
            detectedFormat,
            suggestedAction: suggestion,
            mode,
          };

    const result: AiFallbackContent = {
      content: summary,
      wordCount: countWords(summary),
      metadata,
    };

    if (cache !== undefined && sha !== undefined) {
      cache.set(sha, result);
    }

    const shaLog = sha !== undefined ? ` sha=${sha.slice(0, SHA_LOG_PREFIX_LENGTH)}` : "";
    if (mode === "ask") {
      logger?.info(`ai-fallback: ask-user${shaLog} extension=${ext}`);
    } else {
      logger?.info(`ai-fallback: succeeded${shaLog} extension=${ext}`);
    }

    return result;
  } catch (err) {
    // Resilience: never propagate an internal failure (e.g. a corrupted
    // Buffer whose hashing/slicing throws). Log a warning and treat the
    // file as unhandled so the caller surfaces the original hard failure.
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(`ai-fallback: error extension=${ext} size=${ctx.sizeBytes} reason=${reason}`);
    return null;
  }
}

/**
 * Shared `--prompt-file` input channel.
 *
 * Reads a topic / question VERBATIM from either a file path or standard
 * input (when the source is `-`). This is the bulletproof alternative to
 * passing free-text through a shell argument: the shell never sees the
 * content, so `$VAR`, `$180K`, backticks, and `!` survive untouched (see
 * PM-02). The result is intentionally returned byte-for-byte — no trimming
 * or normalization — so callers receive exactly what the user provided.
 */
import * as fs from "node:fs/promises";

/**
 * Injectable seams for {@link readTextInput}. Tests substitute
 * {@link ReadTextInputOptions.readStdin} so the `-`/stdin path can be
 * exercised deterministically without touching the real process stdin.
 */
export interface ReadTextInputOptions {
  /** Reads all of standard input to a string. Defaults to process stdin. */
  readonly readStdin?: () => Promise<string>;
}

/**
 * Read verbatim text from `source`.
 *
 * @param source A filesystem path, or `-` to read from standard input.
 * @returns The file/stdin contents exactly as provided.
 * @throws Error with a clear, path-naming message when the file is missing
 *   or otherwise unreadable.
 */
export async function readTextInput(
  source: string,
  options: ReadTextInputOptions = {},
): Promise<string> {
  if (source === "-") {
    const readStdin = options.readStdin ?? readProcessStdin;
    return readStdin();
  }

  try {
    return await fs.readFile(source, "utf-8");
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
    if (code === "ENOENT") {
      throw new Error(`Prompt file not found: ${source}`);
    }
    if (code === "EISDIR") {
      throw new Error(`Prompt file is a directory, not a file: ${source}`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read prompt file '${source}': ${detail}`);
  }
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

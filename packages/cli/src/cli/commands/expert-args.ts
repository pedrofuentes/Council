/**
 * Shared parsing for the `--experts` option used by `council convene` and
 * `council panel create`.
 *
 * Both commands declare `--experts` as a *variadic* Commander option
 * (`--experts <slugs...>`) so that every form below captures the full set of
 * experts instead of silently keeping only the first (issue T7 — the
 * PowerShell foot-gun):
 *
 *   --experts a,b,c          single quoted argument
 *   --experts a b c          space-separated — what PowerShell produces when an
 *                            unquoted `a,b,c` is split into an argument array
 *   --experts a --experts b  repeated option
 *
 * Commander hands a variadic option to the action as `string[]`; a bare
 * `string` is also accepted for safety. Each value is comma-split, trimmed,
 * blank fragments dropped, duplicates removed (a panel can never list the same
 * expert twice — `panel_members` is keyed on `(panel_name, expert_slug)`), and
 * the result flattened into one ordered list.
 */
import type { Command } from "commander";

/** Raw value Commander produces for the variadic `--experts` option. */
export type RawExpertsOption = string | readonly string[] | undefined;

/**
 * Normalise the raw `--experts` value into an ordered, de-duplicated slug list.
 * Returns an empty array when nothing usable was supplied; callers decide
 * whether an empty result is an error.
 */
export function parseExpertSlugs(raw: RawExpertsOption): readonly string[] {
  if (raw === undefined) return [];
  const values = typeof raw === "string" ? [raw] : raw;
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const value of values) {
    for (const fragment of value.split(",")) {
      const trimmed = fragment.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        slugs.push(trimmed);
      }
    }
  }
  return slugs;
}

/**
 * Operands Commander parsed but did not bind to a declared positional. With a
 * variadic `--experts`, the normal invocations leave none; leftovers usually
 * mean the user typed bare slugs without the `--experts` flag (or a shell split
 * something unexpectedly), so the caller can warn instead of silently ignoring
 * them.
 */
export function findStrayOperands(
  allOperands: readonly string[],
  declaredArgCount: number,
): readonly string[] {
  if (declaredArgCount <= 0) return [...allOperands];
  return allOperands.slice(declaredArgCount);
}

/** Build the stderr warning shown when stray operands are detected. */
export function formatStrayExpertsWarning(stray: readonly string[]): string {
  const joined = stray.join(" ");
  return (
    `⚠ Ignoring unexpected argument(s): ${stray.join(", ")}.\n` +
    `  If these are expert slugs, pass them with --experts (e.g. --experts ${joined}).\n` +
    `  On PowerShell an unquoted list is split into separate words — quote it: --experts "a,b,c".\n`
  );
}

/**
 * Warn (to stderr) about any operands Commander left unbound. Shared by both
 * commands so the variadic `--experts` option never lets stray slugs vanish
 * without the user noticing.
 */
export function warnOnStrayExpertArgs(
  command: Command,
  writeError: (message: string) => void,
): void {
  const declaredArgCount = command.registeredArguments?.length ?? 0;
  const stray = findStrayOperands(command.args, declaredArgCount);
  if (stray.length > 0) {
    writeError(formatStrayExpertsWarning(stray));
  }
}

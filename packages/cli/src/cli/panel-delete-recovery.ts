/**
 * Shared recovery guidance for a panel delete that removed the on-disk
 * artifacts (YAML + docs directory) but then failed to delete the
 * `panel_library` row — leaving a stale row with no backing files (#1643).
 *
 * The FS-first delete ordering is deliberate: a filesystem failure keeps the
 * DB row authoritative for a retry. When the *DB* delete is the step that
 * fails, re-running `council panel delete <name>` tolerates the now-missing
 * YAML (unlink ENOENT) and directory (fs.rm force) and retries the DB delete,
 * clearing the orphan — so the guidance points the operator there.
 *
 * Both the CLI (`panel delete`) and the TUI panel-authoring delete path use
 * this so they surface identical, discriminating recovery guidance.
 *
 * `name` and `detail` are interpolated into a single-line terminal sink, so
 * the whole message is passed through `toSingleLineDisplay`: control/ANSI/bidi
 * bytes are stripped and any line breaks collapsed. This is defense-in-depth —
 * both delete paths validate the panel name up front — guarding a row whose
 * name bypassed validation via migration/import/direct DB edit.
 */
import { toSingleLineDisplay } from "./strip-control-chars.js";

export function panelDeleteRecoveryMessage(name: string, detail: string): string {
  return toSingleLineDisplay(
    `Removed the panel files for "${name}" but failed to delete its library record: ${detail} ` +
      `The on-disk YAML and docs are gone; a stale entry still exists. ` +
      `Re-run \`council panel delete ${name}\` to clear it.`,
  );
}

import type { ExportFormat } from "../../cli/commands/export.js";
import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { TranscriptDocument } from "../../memory/transcript.js";

/**
 * Pure view source for the TUI export overlay.
 *
 * Maps a `(panelName, format)` pair to a single rendered, display-sanitized
 * preview string by delegating to the same renderers the `council export`
 * command uses (markdown / json / adr / share). It is deliberately a pure
 * function of injected dependencies — no `fs`, no engine, no DB — so the file
 * write stays in the screen (gated, via an injected `writeFile`) and this
 * mapper remains 100%-branch testable offline.
 *
 * The returned preview is what the overlay both renders to its scroll sink and
 * (optionally) writes to disk, so every line is collapsed with
 * `toSingleLineDisplay` — NOT `stripControlChars`, which would preserve the
 * `\r` / `\n` / `\u2028` / `\u2029` characters an attacker can use to forge or
 * CR-overwrite transcript rows. Structural newlines between rendered lines are
 * preserved so the document keeps its shape.
 */
export interface ExportSourceDeps {
  readonly loadTranscript: (
    panelName: string,
    debateId?: string,
  ) => Promise<TranscriptDocument | null>;
  readonly renderMarkdown: (doc: TranscriptDocument) => string;
  readonly renderJson: (doc: TranscriptDocument) => string;
  readonly renderAdr: (doc: TranscriptDocument) => string;
  readonly renderShare: (doc: TranscriptDocument) => string;
}

export interface ExportDataSource {
  /**
   * Render the panel's transcript in `format`, returning the sanitized preview
   * string, or `null` when no transcript is available for `panelName`.
   */
  readonly render: (
    panelName: string,
    format: ExportFormat,
    debateId?: string,
  ) => Promise<string | null>;
}

/**
 * Collapse every line of `rendered` to a single safe display line while
 * preserving the newlines that separate lines. Splitting first means the only
 * surviving `\n`s are the structural ones we re-add, so untrusted content can
 * never forge an extra row or CR-overwrite a label.
 */
function sanitizeForDisplay(rendered: string): string {
  return rendered.split("\n").map(toSingleLineDisplay).join("\n");
}

export function createExportSource(deps: ExportSourceDeps): ExportDataSource {
  const renderers: Record<ExportFormat, (doc: TranscriptDocument) => string> = {
    markdown: deps.renderMarkdown,
    json: deps.renderJson,
    adr: deps.renderAdr,
    share: deps.renderShare,
  };

  return {
    render: async (
      panelName: string,
      format: ExportFormat,
      debateId?: string,
    ): Promise<string | null> => {
      const doc = await deps.loadTranscript(panelName, debateId);
      if (doc === null) {
        return null;
      }
      return sanitizeForDisplay(renderers[format](doc));
    },
  };
}

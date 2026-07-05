/**
 * Shared runtime helpers for driving a *saved* (library / user) panel from a
 * non-interactive command — currently `council ask <saved-panel>`.
 *
 * These extract the two pieces that `council chat`'s panel path already does
 * (loading a saved panel + resolving its experts against the library, and
 * refreshing the panel's RAG corpus) so the headless `ask` fallback can reuse
 * them verbatim instead of duplicating the logic. Keeping them here — a small
 * leaf module with no Commander/TUI dependencies — lets both the interactive
 * `chat` panel loop and the headless `ask` path share one implementation.
 */
import type { CouncilConfig } from "../../config/index.js";
import { FileExpertLibrary } from "../../core/expert-library.js";
import type { ExpertDefinition } from "../../core/expert.js";
import {
  scanAndIndexPanelDocuments,
  type PanelScanResult,
} from "../../core/documents/panel-document-scanner.js";
import { loadPanel, resolveExperts, type PanelDefinition } from "../../core/template-loader.js";
import type { CouncilDatabase } from "../../memory/db.js";

import { resolveManagedDocsDir } from "./docs.js";

/**
 * A saved panel loaded from disk together with the outcome of resolving its
 * expert entries against the on-disk / cached library.
 */
export interface LoadedSavedPanel {
  /** The panel definition as authored (user panel or built-in template). */
  readonly panel: PanelDefinition;
  /** Experts that resolved to a concrete definition, in panel order. */
  readonly resolved: readonly ExpertDefinition[];
  /** Slugs referenced by the panel that the library could not resolve. */
  readonly missing: readonly string[];
}

/**
 * Load a saved panel by name and resolve its experts — the same way the
 * `chat` panel path does (`FileExpertLibrary` + {@link resolveExperts}).
 *
 * `loadPanel` prefers a user panel in `<dataHome>/panels/<name>.{yaml,yml}`
 * and falls back to the built-in templates that ship with Council, so both a
 * saved kebab-case panel and a built-in template (e.g. `code-review`) resolve
 * through this one call. A genuinely absent name surfaces as
 * `PanelNotFoundError` from `loadPanel`, which the caller handles.
 */
export async function loadSavedPanelExperts(
  panelName: string,
  dataHome: string,
  db: CouncilDatabase,
): Promise<LoadedSavedPanel> {
  const panel = await loadPanel(panelName, dataHome);
  const library = new FileExpertLibrary(dataHome, db);
  const { resolved, missing } = await resolveExperts(panel.experts, library);
  return { panel, resolved, missing };
}

export interface ScanPanelDocumentsOptions {
  readonly panelName: string;
  readonly dataHome: string;
  readonly db: CouncilDatabase;
  readonly config: CouncilConfig;
}

/**
 * Refresh a panel's RAG corpus by scanning and indexing its managed docs
 * (`<dataHome>/panels/<name>/docs`) plus any linked folders. Extracted from
 * the `chat` panel loop so the headless `ask` path indexes documents the same
 * way before retrieval. Returns the raw {@link PanelScanResult}; callers decide
 * whether/how to render it. Callers should treat failures as non-fatal.
 */
export async function scanPanelDocuments(
  options: ScanPanelDocumentsOptions,
): Promise<PanelScanResult> {
  const { panelName, dataHome, db, config } = options;
  const managedDocsDir = resolveManagedDocsDir(dataHome, panelName);
  return scanAndIndexPanelDocuments({
    panelName,
    managedDocsDir,
    db,
    supportedFormats: config.expert.supportedFormats,
    maxFileSizeBytes: config.documents.maxFileSizeMB * 1024 * 1024,
    aiFallback: {
      mode: config.documents.aiExtraction,
      allowedExtensions: config.documents.aiExtractionAllowedExtensions,
    },
  });
}

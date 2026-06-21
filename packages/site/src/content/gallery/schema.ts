/**
 * Gallery entry schema for the Council panel library.
 * This defines the shape of panel metadata that the library track will populate.
 */

export interface GalleryEntry {
  /** Unique identifier for the panel */
  readonly id: string;

  /** Human-readable panel name */
  readonly name: string;

  /** Brief summary of the panel's purpose */
  readonly summary: string;

  /** Disciplines covered by this panel (e.g., "Software Engineering", "Law") */
  readonly disciplines: readonly string[];

  /** Expert roles in the panel */
  readonly experts: readonly string[];

  /** Example prompts that work well with this panel */
  readonly samplePrompts: readonly string[];

  /** Installation snippet (e.g., npm command or import statement) */
  readonly installSnippet: string;

  /** Maturity level badge (e.g., "stable", "experimental", "beta") */
  readonly maturity: "stable" | "experimental" | "beta" | "alpha";
}

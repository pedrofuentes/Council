/**
 * Type augmentation for Vitest's `provide` / `inject` mechanism.
 *
 * Values provided by `tests/global-setup.ts` via `project.provide()`
 * are declared here so that `inject("templateDbPath")` is type-safe
 * in every test file.
 */
declare module "vitest" {
  export interface ProvidedContext {
    /** Absolute path to the pre-migrated template SQLite database. */
    templateDbPath: string;
  }
}

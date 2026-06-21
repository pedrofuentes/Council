/**
 * @council-ai/cli — Programmatic API entry point.
 *
 * The primary user-facing surface is the CLI in `src/bin/council.ts`.
 * This module re-exports a small, stable slice of that surface for
 * programmatic and tooling consumers — currently `buildProgram()`, which the
 * documentation site introspects to auto-generate the command reference and
 * keep it from drifting out of sync with the real Commander definitions.
 *
 * `buildProgram()` only constructs the fully-wired Commander program; it never
 * parses `process.argv`, so importing this module does not run the CLI.
 */
export { buildProgram } from "./bin/council.js";
export type { BuildProgramOptions } from "./bin/council.js";

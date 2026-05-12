/**
 * Public entry for the configuration module.
 *
 * Re-exports schema + loader so consumers import from a single path:
 *
 *   import { loadConfig, getCouncilHome, ConfigSchema } from "../config/index.js";
 */
export { ConfigSchema, DEFAULT_MODEL } from "./schema.js";
export type { CouncilConfig } from "./schema.js";
export { ensureDataDirectories, getCouncilDataHome, getCouncilHome, loadConfig } from "./loader.js";

/**
 * Public entry for the configuration module.
 *
 * Re-exports schema + loader so consumers import from a single path:
 *
 *   import { loadConfig, getCouncilHome, ConfigSchema } from "../config/index.js";
 */
export { ConfigSchema, DEFAULT_MODEL, ENGINE_CHOICES } from "./schema.js";
export type { CouncilConfig, EngineChoice } from "./schema.js";
export {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  loadConfigWithMeta,
  resolveEngine,
} from "./loader.js";
export type { ConfigLoadResult } from "./loader.js";

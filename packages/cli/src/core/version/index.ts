/**
 * Public entry for the version/update-notification module.
 *
 * Re-exports the registry probe and the throttled startup notifier so the CLI
 * entry point can wire everything from a single path:
 *
 *   import { maybeNotifyUpdate } from "../core/version/index.js";
 */
export { fetchLatestVersion, isNewerVersion, type FetchLatestVersionOptions } from "./registry.js";
export {
  formatUpdateNotice,
  maybeNotifyUpdate,
  readUpdateCache,
  refreshUpdateCache,
  writeUpdateCache,
  type MaybeNotifyUpdateOptions,
  type RefreshUpdateCacheOptions,
  type UpdateCache,
} from "./update-notifier.js";

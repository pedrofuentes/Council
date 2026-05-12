/**
 * Configuration loader.
 *
 * Resolution rules:
 *   1. Council home directory:
 *        - `process.env.COUNCIL_HOME` if set (used by --ephemeral mode and tests)
 *        - Else `~/.council`
 *   2. Config file: `<home>/config.yaml`
 *   3. If the file is missing, write the schema defaults and continue.
 *   4. If the file exists, parse YAML, validate via ConfigSchema, return typed
 *      CouncilConfig. Validation errors include the offending path + reason.
 *
 * Designed to be called from CLI commands and from `council doctor`. Never
 * throws on a missing home directory — creates it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "yaml";
import type { ZodError } from "zod";

import { ConfigSchema, type CouncilConfig } from "./schema.js";

const CONFIG_FILE = "config.yaml";

/**
 * Resolve the directory that holds Council's runtime data.
 * Honors `COUNCIL_HOME` so tests can isolate without touching the user's $HOME.
 */
export function getCouncilHome(): string {
  const envHome = process.env["COUNCIL_HOME"];
  if (envHome && envHome.length > 0) return envHome;
  return path.join(os.homedir(), ".council");
}

/**
 * Resolve the user-facing data directory for Council expert/panel YAML.
 * Honors `COUNCIL_DATA_HOME` env var for test isolation. Falls back to
 * `config.paths.dataHome` (with `~` expansion), then `~/Council`.
 *
 * Kept separate from `getCouncilHome()` so the visible YAML library
 * (`~/Council/`) is distinct from the hidden runtime dir (`~/.council/`).
 */
export function getCouncilDataHome(config?: CouncilConfig): string {
  const envHome = process.env["COUNCIL_DATA_HOME"];
  if (envHome && envHome.length > 0) return envHome;
  if (config?.paths?.dataHome) {
    const dataHome = config.paths.dataHome;
    if (dataHome === "~") return os.homedir();
    if (dataHome.startsWith("~/")) {
      return path.join(os.homedir(), dataHome.slice(2));
    }
    return dataHome;
  }
  return path.join(os.homedir(), "Council");
}

/**
 * Ensure the user-facing data directories exist. Creates
 * `<dataHome>/experts/` and `<dataHome>/panels/` if missing. Idempotent.
 */
export async function ensureDataDirectories(dataHome: string): Promise<void> {
  await fs.mkdir(path.join(dataHome, "experts"), { recursive: true });
  await fs.mkdir(path.join(dataHome, "panels"), { recursive: true });
}

function configPath(): string {
  return path.join(getCouncilHome(), CONFIG_FILE);
}

async function ensureHomeDirectory(): Promise<void> {
  await fs.mkdir(getCouncilHome(), { recursive: true });
}

async function writeDefaultConfig(): Promise<CouncilConfig> {
  const defaults: CouncilConfig = ConfigSchema.parse({});
  const yamlText = yaml.stringify(defaults);
  const banner =
    "# Council configuration\n" +
    "# See https://github.com/pedrofuentes/Council for documentation.\n" +
    "# Edit values below; missing fields use built-in defaults.\n\n";
  await fs.writeFile(configPath(), banner + yamlText, "utf-8");
  return defaults;
}

function formatZodError(err: ZodError, source: string): Error {
  const lines = err.issues.map((i) => {
    const fieldPath = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `  - ${fieldPath}: ${i.message}`;
  });
  return new Error(`Invalid Council config in ${source}:\n${lines.join("\n")}`);
}

/**
 * Load (or create) the Council config file.
 * Always returns a fully-defaulted CouncilConfig.
 */
export async function loadConfig(): Promise<CouncilConfig> {
  await ensureHomeDirectory();
  const file = configPath();

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return writeDefaultConfig();
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Council config (${file}): ${cause}`);
  }

  // Empty file -> empty object -> defaults
  const input: unknown = parsed ?? {};

  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw formatZodError(result.error, file);
  }
  return result.data;
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

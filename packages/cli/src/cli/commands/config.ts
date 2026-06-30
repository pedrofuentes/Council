/**
 * `council config show|path|edit` — config discoverability subcommands.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";
import * as yaml from "yaml";

import {
  ConfigSchema,
  ENGINE_CHOICES,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  updateConfigField,
} from "../../config/index.js";
import { updateConfigFields } from "../../config/loader.js";
import { discoverAvailableModels, type ModelDiscoveryResult } from "../../engine/copilot/health.js";
import { isSupportedModel, SUPPORTED_MODELS } from "../../engine/models.js";
import { orderModelsByPreference, writeModelList } from "../first-run-model-select.js";
import { CliUserError } from "../cli-user-error.js";
import { toSingleLineDisplay } from "../strip-control-chars.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const CONFIG_FILE = "config.yaml";
const SETTABLE_CONFIG_KEYS = [
  "defaults.model",
  "defaults.engine",
  "defaults.maxRounds",
  "defaults.maxExperts",
  "defaults.maxWordsPerResponse",
  "telemetry.enabled",
  "chat.recentTurnCount",
  "chat.summaryMaxWords",
  "chat.longConversationWarning",
  "documents.aiExtraction",
  "documents.aiExtractionAllowedExtensions",
  "documents.maxFileSizeMB",
  "expert.recencyHalfLifeDays",
  "expert.supportedFormats",
  "conclude.maxTranscriptChars",
  "qualityGate.mode",
  "qualityGate.maxRegenerations",
  "paths.dataHome",
] as const;

type SettableConfigKey = (typeof SETTABLE_CONFIG_KEYS)[number];
type ConfigValue = string | number | boolean | readonly string[];
interface ConfigUpdate {
  readonly key: SettableConfigKey;
  readonly value: ConfigValue;
}

interface TtyReadableStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface ConfigWizardDependencies {
  readonly input?: TtyReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly discoverModels?: typeof discoverAvailableModels;
}

function getConfigFilePath(): string {
  return path.join(getCouncilHome(), CONFIG_FILE);
}

type EditorRunner = (editor: string, filePath: string) => Promise<void>;

function resolveEditor(): string {
  const fromEnv = process.env["VISUAL"] ?? process.env["EDITOR"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return process.platform === "win32" ? "notepad" : "vi";
}

async function spawnEditor(editorCmd: string, filePath: string): Promise<void> {
  const parts = editorCmd.match(/(?:"[^"]*"|\S)+/g) ?? [editorCmd];
  const head = parts[0] ?? editorCmd;
  const exe = head.replace(/^"|"$/g, "");
  const args = parts
    .slice(1)
    .map((p) => p.replace(/^"|"$/g, ""))
    .concat(filePath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal !== null) {
        reject(new Error(`Editor "${exe}" was terminated by signal ${signal}`));
        return;
      }
      reject(new Error(`Editor "${exe}" exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * Determine which config fields came from the file vs defaults.
 * Reads the raw YAML and compares against schema defaults.
 */
async function getFieldSources(
  configPath: string,
): Promise<Map<string, "config file" | "default">> {
  const sources = new Map<string, "config file" | "default">();

  let rawObj: Record<string, unknown> = {};
  try {
    const rawText = await fs.readFile(configPath, "utf-8");
    const parsed = yaml.parse(rawText) as unknown;
    if (parsed && typeof parsed === "object") {
      rawObj = parsed as Record<string, unknown>;
    }
  } catch {
    // File missing or unreadable — all values are defaults
  }

  const rawDefaults =
    rawObj["defaults"] && typeof rawObj["defaults"] === "object"
      ? (rawObj["defaults"] as Record<string, unknown>)
      : {};

  const defaultKeys = ["model", "engine", "maxRounds", "maxExperts", "maxWordsPerResponse"];
  for (const key of defaultKeys) {
    sources.set(`defaults.${key}`, key in rawDefaults ? "config file" : "default");
  }

  const rawTelemetry =
    rawObj["telemetry"] && typeof rawObj["telemetry"] === "object"
      ? (rawObj["telemetry"] as Record<string, unknown>)
      : {};
  sources.set("telemetry.enabled", "enabled" in rawTelemetry ? "config file" : "default");

  const rawChat =
    rawObj["chat"] && typeof rawObj["chat"] === "object"
      ? (rawObj["chat"] as Record<string, unknown>)
      : {};
  const chatKeys = ["recentTurnCount", "summaryMaxWords", "longConversationWarning"];
  for (const key of chatKeys) {
    sources.set(`chat.${key}`, key in rawChat ? "config file" : "default");
  }

  const rawDocuments =
    rawObj["documents"] && typeof rawObj["documents"] === "object"
      ? (rawObj["documents"] as Record<string, unknown>)
      : {};

  const documentKeys = ["aiExtraction", "aiExtractionAllowedExtensions", "maxFileSizeMB"];
  for (const key of documentKeys) {
    sources.set(`documents.${key}`, key in rawDocuments ? "config file" : "default");
  }

  const rawConclude =
    rawObj["conclude"] && typeof rawObj["conclude"] === "object"
      ? (rawObj["conclude"] as Record<string, unknown>)
      : {};

  sources.set(
    "conclude.maxTranscriptChars",
    "maxTranscriptChars" in rawConclude ? "config file" : "default",
  );

  return sources;
}

function buildShowCommand(write: Writer): Command {
  const cmd = new Command("show");
  cmd.description("Print effective config values with source annotation").action(async () => {
    const configFilePath = getConfigFilePath();
    const config = await loadConfig();
    const sources = await getFieldSources(configFilePath);

    const councilHome = getCouncilHome();
    const dataHome = getCouncilDataHome(config);
    const expertsDir = path.join(dataHome, "experts");
    const panelsDir = path.join(dataHome, "panels");
    const dbPath = path.join(councilHome, "council.db");

    write(`Config path: ${toSingleLineDisplay(configFilePath)}\n`);
    write(`Council home: ${toSingleLineDisplay(councilHome)}  (config file, database)\n`);
    write(`Data home: ${toSingleLineDisplay(dataHome)}  (experts, panels, documents)\n`);
    write(`Experts directory: ${toSingleLineDisplay(expertsDir)}\n`);
    write(`Panels directory: ${toSingleLineDisplay(panelsDir)}\n`);
    write(`Database: ${toSingleLineDisplay(dbPath)}\n\n`);
    write("Effective values:\n");

    const allowedExts = config.documents.aiExtractionAllowedExtensions;
    const entries: [string, string, string][] = [
      ["defaults.model", config.defaults.model, sources.get("defaults.model") ?? "default"],
      ["defaults.engine", config.defaults.engine, sources.get("defaults.engine") ?? "default"],
      [
        "defaults.maxRounds",
        String(config.defaults.maxRounds),
        sources.get("defaults.maxRounds") ?? "default",
      ],
      [
        "defaults.maxExperts",
        String(config.defaults.maxExperts),
        sources.get("defaults.maxExperts") ?? "default",
      ],
      [
        "defaults.maxWordsPerResponse",
        String(config.defaults.maxWordsPerResponse),
        sources.get("defaults.maxWordsPerResponse") ?? "default",
      ],
      [
        "documents.aiExtraction",
        config.documents.aiExtraction,
        sources.get("documents.aiExtraction") ?? "default",
      ],
      [
        "telemetry.enabled",
        String(config.telemetry.enabled),
        sources.get("telemetry.enabled") ?? "default",
      ],
      [
        "chat.recentTurnCount",
        String(config.chat.recentTurnCount),
        sources.get("chat.recentTurnCount") ?? "default",
      ],
      [
        "chat.summaryMaxWords",
        String(config.chat.summaryMaxWords),
        sources.get("chat.summaryMaxWords") ?? "default",
      ],
      [
        "chat.longConversationWarning",
        String(config.chat.longConversationWarning),
        sources.get("chat.longConversationWarning") ?? "default",
      ],
      [
        "documents.aiExtractionAllowedExtensions",
        allowedExts.length === 0 ? "(none)" : allowedExts.join(", "),
        sources.get("documents.aiExtractionAllowedExtensions") ?? "default",
      ],
      [
        "documents.maxFileSizeMB",
        String(config.documents.maxFileSizeMB),
        sources.get("documents.maxFileSizeMB") ?? "default",
      ],
      [
        "conclude.maxTranscriptChars",
        String(config.conclude.maxTranscriptChars),
        sources.get("conclude.maxTranscriptChars") ?? "default",
      ],
    ];

    const keyWidth = Math.max(...entries.map(([k]) => k.length));
    for (const [key, value, source] of entries) {
      write(`  ${key.padEnd(keyWidth)}  ${toSingleLineDisplay(value).padEnd(24)} (${source})\n`);
    }
  });
  return cmd;
}

function buildPathCommand(write: Writer): Command {
  const cmd = new Command("path");
  cmd.description("Print the config file path (useful for scripts)").action(() => {
    write(toSingleLineDisplay(getConfigFilePath()) + "\n");
  });
  return cmd;
}

function buildEditCommand(write: Writer, writeError: Writer, editorRunner?: EditorRunner): Command {
  const cmd = new Command("edit");
  cmd.description("Open the config file in $EDITOR and validate on save").action(async () => {
    const configFilePath = getConfigFilePath();

    // Ensure config file exists before opening editor
    await loadConfig();

    // Preserve original contents for rollback on validation failure
    const originalContents = await fs.readFile(configFilePath, "utf-8");

    const editor = resolveEditor();
    const runner = editorRunner ?? spawnEditor;
    await runner(editor, configFilePath);

    // Validate the saved file
    let rawText: string;
    try {
      rawText = await fs.readFile(configFilePath, "utf-8");
    } catch (err: unknown) {
      const msg = `Cannot read config after edit: ${err instanceof Error ? err.message : String(err)}`;
      writeError(`${msg}\n`);
      throw new CliUserError(msg);
    }

    let parsed: unknown;
    try {
      parsed = yaml.parse(rawText);
    } catch (err: unknown) {
      const msg = `YAML parse error: ${err instanceof Error ? err.message : String(err)}`;
      writeError(`Validation failed: ${msg}\n`);
      await restoreOriginalConfig(configFilePath, originalContents, writeError);
      throw new CliUserError(msg);
    }

    const result = ConfigSchema.safeParse(parsed ?? {});
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      writeError(`Validation failed:\n${issues}\n`);
      await restoreOriginalConfig(configFilePath, originalContents, writeError);
      throw new CliUserError("Config validation failed after edit");
    }

    write("Config saved and valid.\n");
  });
  return cmd;
}

function isSettableConfigKey(key: string): key is SettableConfigKey {
  return SETTABLE_CONFIG_KEYS.includes(key as SettableConfigKey);
}

/**
 * Restore the original config after a failed edit. The rollback write is
 * guarded so a secondary failure (disk-full, permission change) surfaces an
 * explicit warning and a stable {@link CliUserError} rather than leaking a raw
 * fs error that would mask the validation message and leave the file corrupt.
 */
async function restoreOriginalConfig(
  configFilePath: string,
  originalContents: string,
  writeError: Writer,
): Promise<void> {
  try {
    await fs.writeFile(configFilePath, originalContents, "utf-8");
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    writeError(`Original config could not be restored: ${reason}\n`);
    writeError(`Manual recovery may be required: ${configFilePath}\n`);
    throw new CliUserError(`Original config could not be restored: ${reason}`);
  }
  writeError("Original config has been restored.\n");
}

/**
 * Parse a comma-separated extension list into a normalized array:
 * trimmed, lowercased, leading-dot-prefixed, de-duplicated, with empty
 * segments dropped. An empty (or all-whitespace) value yields `[]`,
 * which clears the allow-list — meaning "all non-blocklisted extensions
 * are eligible" per the schema contract. Normalizing the leading dot
 * matters: the AI-fallback eligibility check (`isExtensionAiEligible`)
 * compares against `path.extname()` output, which always includes the
 * dot, so `png` and `.png` must collapse to the same stored value.
 */
function normalizeExtensionList(rawValue: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of rawValue.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    const ext = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (seen.has(ext)) continue;
    seen.add(ext);
    result.push(ext);
  }
  return result;
}

/**
 * Coerce a raw CLI string into an integer for an integer-valued config key.
 *
 * `Number()` is far too permissive for config input: it silently maps empty or
 * whitespace-only strings to `0` and accepts hex (`0x2`), exponent (`1e0`), and
 * fractional (`1.0`) forms. Such values are then either stored verbatim where
 * the schema range happens to allow them (e.g. `qualityGate.maxRegenerations ""`
 * → `0`) or surface a confusing downstream schema error. Reject anything that is
 * not a plain, optionally-signed decimal integer up front so every integer key
 * behaves identically. `invalidMessage` lets a key fold this rejection into its
 * own range message; both default and override are sanitized via
 * `toSingleLineDisplay` at the call site.
 */
function parseIntegerConfigValue(
  key: SettableConfigKey,
  rawValue: string,
  invalidMessage?: string,
): number {
  const trimmed = rawValue.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new CliUserError(
      invalidMessage ?? `Config value for ${toSingleLineDisplay(key)} must be an integer.`,
    );
  }
  return Number.parseInt(trimmed, 10);
}

function coerceConfigValue(
  key: SettableConfigKey,
  rawValue: string,
): string | number | boolean | readonly string[] {
  switch (key) {
    case "defaults.maxRounds":
    case "defaults.maxExperts":
    case "defaults.maxWordsPerResponse":
    case "chat.recentTurnCount":
    case "chat.summaryMaxWords":
    case "chat.longConversationWarning":
    case "expert.recencyHalfLifeDays": {
      return parseIntegerConfigValue(key, rawValue);
    }
    case "telemetry.enabled": {
      const normalized = rawValue.trim().toLowerCase();
      if (["true", "yes", "y", "on", "1"].includes(normalized)) return true;
      if (["false", "no", "n", "off", "0"].includes(normalized)) return false;
      throw new CliUserError(`Config value for ${toSingleLineDisplay(key)} must be true or false.`);
    }
    case "defaults.engine": {
      if (!ENGINE_CHOICES.includes(rawValue as (typeof ENGINE_CHOICES)[number])) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must be one of: ${ENGINE_CHOICES.map((choice) => toSingleLineDisplay(choice)).join(", ")}`,
        );
      }
      return rawValue;
    }
    case "documents.aiExtraction": {
      const validValues = ["off", "ask", "auto"] as const;
      if (!validValues.includes(rawValue as (typeof validValues)[number])) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must be one of: ${validValues
            .map((choice) => toSingleLineDisplay(choice))
            .join(", ")}`,
        );
      }
      return rawValue;
    }
    case "documents.aiExtractionAllowedExtensions":
    case "expert.supportedFormats": {
      return normalizeExtensionList(rawValue);
    }
    case "paths.dataHome": {
      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must be a non-empty path.`,
        );
      }
      // A filesystem path must never carry terminal-control bytes (ANSI/OSC
      // sequences, C0/C1 controls, DEL, CR/LF/TAB, U+2028/U+2029). Persisting
      // one would let it survive into `council config show` and detonate later
      // as a stored terminal-injection.
      if (toSingleLineDisplay(trimmed) !== trimmed) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must not contain control characters.`,
        );
      }
      return trimmed;
    }
    case "documents.maxFileSizeMB": {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must be a number between 1 and 500.`,
        );
      }
      return parsed;
    }
    case "conclude.maxTranscriptChars": {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 1000000) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must be a number between 1000 and 1000000.`,
        );
      }
      return parsed;
    }
    case "qualityGate.mode": {
      const validValues = ["off", "warn", "regenerate"] as const;
      if (!validValues.includes(rawValue as (typeof validValues)[number])) {
        throw new CliUserError(
          `Config value for ${toSingleLineDisplay(key)} must be one of: ${validValues
            .map((choice) => toSingleLineDisplay(choice))
            .join(", ")}`,
        );
      }
      return rawValue;
    }
    case "qualityGate.maxRegenerations": {
      const rangeMessage = `Config value for ${toSingleLineDisplay(key)} must be an integer between 0 and 3.`;
      const parsed = parseIntegerConfigValue(key, rawValue, rangeMessage);
      if (parsed < 0 || parsed > 3) {
        throw new CliUserError(rangeMessage);
      }
      return parsed;
    }
    default:
      return rawValue;
  }
}

function isInteractiveInput(input: TtyReadableStream | undefined): boolean {
  const activeInput = input ?? process.stdin;
  return activeInput.isTTY === true;
}

function formatWizardValue(value: ConfigValue): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "none" : value.map((item) => toSingleLineDisplay(item)).join(", ");
  }
  if (typeof value === "string") return toSingleLineDisplay(value);
  return String(value);
}

function formatWizardKey(key: SettableConfigKey): string {
  return toSingleLineDisplay(key);
}

function promptText(output: NodeJS.WritableStream, label: string, current: ConfigValue): void {
  output.write(`${label} [${formatWizardValue(current)}]: `);
}

function selectChoice(
  rawValue: string,
  choices: readonly string[],
  current: string,
  key: SettableConfigKey,
): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return current;
  if (/^\d+$/.test(trimmed)) {
    const selected = choices[Number.parseInt(trimmed, 10) - 1];
    if (selected !== undefined) return selected;
  }
  if (choices.includes(trimmed)) return trimmed;
  throw new CliUserError(
    `Config value for ${formatWizardKey(key)} must be one of: ${choices
      .map((choice) => toSingleLineDisplay(choice))
      .join(", ")}`,
  );
}

async function promptForModel(
  line: () => Promise<string>,
  write: Writer,
  output: NodeJS.WritableStream,
  discoverModels: typeof discoverAvailableModels,
): Promise<string> {
  write("Discovering available models...\n\n");
  const discovery: ModelDiscoveryResult = await discoverModels();
  const models = orderModelsByPreference(discovery.models);
  if (discovery.source === "static") {
    write(
      "Warning: Live model discovery failed, so Council is showing a built-in fallback list.\n\n",
    );
  }
  if (models.length === 0) {
    throw new CliUserError(
      "No AI models are available. Run 'council doctor' to verify your setup.",
    );
  }
  writeModelList(
    write,
    models.map((model) => toSingleLineDisplay(model)),
  );
  output.write(`Default model [1-${models.length}] (Enter for recommended): `);
  const selected = selectChoice(await line(), models, models[0] ?? "", "defaults.model");
  write(`Set ${formatWizardKey("defaults.model")} = ${toSingleLineDisplay(selected)}\n`);
  return selected;
}

async function promptForValue(
  key: SettableConfigKey,
  label: string,
  current: ConfigValue,
  line: () => Promise<string>,
  output: NodeJS.WritableStream,
): Promise<ConfigValue> {
  promptText(output, label, current);
  const rawValue = (await line()).trim();
  if (rawValue.length === 0) return current;
  const value =
    key === "defaults.engine"
      ? selectChoice(rawValue, ENGINE_CHOICES, String(current), key)
      : key === "documents.aiExtraction"
        ? selectChoice(rawValue, ["off", "ask", "auto"], String(current), key)
        : key === "qualityGate.mode"
          ? selectChoice(rawValue, ["off", "warn", "regenerate"], String(current), key)
          : coerceConfigValue(key, rawValue);
  return value;
}

function setValueInConfig(
  config: Awaited<ReturnType<typeof loadConfig>>,
  key: SettableConfigKey,
  value: string | number | boolean | readonly string[],
): unknown {
  const clone: Record<string, unknown> = structuredClone(config) as Record<string, unknown>;
  const parts = key.split(".");
  let target = clone;
  for (const part of parts.slice(0, -1)) {
    const next = target[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  }
  target[parts[parts.length - 1] ?? key] = value;
  return clone;
}

async function runWizard(write: Writer, deps: ConfigWizardDependencies | undefined): Promise<void> {
  const input = deps?.input;
  if (!isInteractiveInput(input)) {
    throw new CliUserError(
      'Non-interactive mode: "config wizard" requires an interactive terminal or injected input.',
    );
  }

  const output = deps?.output ?? process.stdout;
  const rl = createInterface({
    input: input ?? process.stdin,
    output,
    terminal: false,
  });
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const next = await lines.next();
    if (next.done === true) {
      throw new CliUserError("Config wizard aborted before completion.");
    }
    return next.value;
  };

  try {
    write("Config wizard. Press Ctrl+C to abort.\n\n");
    const config = await loadConfig();
    const values: readonly [
      SettableConfigKey,
      string,
      string | number | boolean | readonly string[],
    ][] = [
      ["defaults.engine", `Default engine (${ENGINE_CHOICES.join("/")})`, config.defaults.engine],
      ["defaults.maxRounds", "Maximum debate rounds (1-20)", config.defaults.maxRounds],
      ["defaults.maxExperts", "Maximum experts per panel (2-8)", config.defaults.maxExperts],
      [
        "defaults.maxWordsPerResponse",
        "Maximum words per expert response (50-2000)",
        config.defaults.maxWordsPerResponse,
      ],
      ["telemetry.enabled", "Telemetry enabled (yes/no)", config.telemetry.enabled],
      ["chat.recentTurnCount", "Recent chat turns to keep (5-50)", config.chat.recentTurnCount],
      ["chat.summaryMaxWords", "Chat summary max words (100-2000)", config.chat.summaryMaxWords],
      [
        "chat.longConversationWarning",
        "Long conversation warning turn count (50-10000)",
        config.chat.longConversationWarning,
      ],
      [
        "documents.aiExtraction",
        "AI document extraction mode (off/ask/auto)",
        config.documents.aiExtraction,
      ],
      [
        "documents.aiExtractionAllowedExtensions",
        "AI extraction extensions (comma-separated, blank for current)",
        config.documents.aiExtractionAllowedExtensions,
      ],
      [
        "documents.maxFileSizeMB",
        "Maximum document file size in MB (1-500)",
        config.documents.maxFileSizeMB,
      ],
      [
        "conclude.maxTranscriptChars",
        "Conclude transcript character budget (1000-1000000)",
        config.conclude.maxTranscriptChars,
      ],
      ["qualityGate.mode", "Quality gate mode (off/warn/regenerate)", config.qualityGate.mode],
      [
        "qualityGate.maxRegenerations",
        "Quality gate max regenerations (0-3)",
        config.qualityGate.maxRegenerations,
      ],
      [
        "expert.recencyHalfLifeDays",
        "Expert source recency half-life in days (1-365)",
        config.expert.recencyHalfLifeDays,
      ],
      ["paths.dataHome", "Data home directory for experts and panels", config.paths.dataHome],
    ];

    const updates: ConfigUpdate[] = [];
    let stagedConfig = config;
    const stageUpdate = (key: SettableConfigKey, value: ConfigValue): void => {
      stagedConfig = ConfigSchema.parse(setValueInConfig(stagedConfig, key, value));
      updates.push({ key, value });
    };

    const model = await promptForModel(
      nextLine,
      write,
      output,
      deps?.discoverModels ?? discoverAvailableModels,
    );
    stageUpdate("defaults.model", model);

    for (const [key, label, current] of values) {
      const value = await promptForValue(key, label, current, nextLine, output);
      stageUpdate(key, value);
      write(`Set ${formatWizardKey(key)} = ${formatWizardValue(value)}\n`);
    }
    await updateConfigFields(updates);
    write("\nConfig wizard complete.\n");
  } finally {
    rl.close();
  }
}

function buildSetCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("set");
  cmd
    .description("Set a supported config value")
    .argument("<key>", "Dot-notation config key")
    .argument("<value>", "Value to write")
    .action(async (key: string, rawValue: string) => {
      if (!isSettableConfigKey(key)) {
        const msg = `Unsupported config key "${toSingleLineDisplay(key)}". Valid keys:\n  - ${SETTABLE_CONFIG_KEYS.join("\n  - ")}`;
        writeError(`${msg}\n`);
        throw new CliUserError(msg);
      }

      let value: string | number | boolean | readonly string[];
      try {
        value = coerceConfigValue(key, rawValue);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        writeError(`${msg}\n`);
        throw err instanceof CliUserError ? err : new CliUserError(msg);
      }

      try {
        await updateConfigField(key, value);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        writeError(`${msg}\n`);
        throw new CliUserError(msg);
      }

      const displayValue = Array.isArray(value)
        ? value.length === 0
          ? "(none)"
          : value.map((item) => toSingleLineDisplay(item)).join(", ")
        : typeof value === "string"
          ? toSingleLineDisplay(value)
          : String(value);
      write(`Set ${key} = ${displayValue}\n`);

      if (key === "paths.dataHome") {
        // `value` is the user-supplied path string; it must be sanitized
        // before being echoed to the terminal (terminal-injection safety).
        const safePath = toSingleLineDisplay(String(value));
        write(
          `Note: existing data at the previous location is not moved automatically. ` +
            `Council will use '${safePath}' for new data — move any existing files there manually if needed.\n`,
        );
      }
    });
  return cmd;
}

function buildWizardCommand(
  write: Writer,
  writeError: Writer,
  wizardDeps?: ConfigWizardDependencies,
): Command {
  const cmd = new Command("wizard");
  cmd.description("Guided interactive setup for common config values").action(async () => {
    try {
      await runWizard(write, wizardDeps);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const displayMsg = toSingleLineDisplay(msg);
      writeError(`${displayMsg}\n`);
      throw new CliUserError(displayMsg);
    }
  });
  return cmd;
}

/** Persist an explicitly named model after validating it against the registry. */
async function setModelByName(name: string, write: Writer, writeError: Writer): Promise<void> {
  if (!isSupportedModel(name)) {
    const msg = `Unsupported model "${toSingleLineDisplay(name)}". Valid models:\n  - ${SUPPORTED_MODELS.join("\n  - ")}`;
    writeError(`${msg}\n`);
    throw new CliUserError(msg);
  }
  try {
    await updateConfigField("defaults.model", name);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    writeError(`${msg}\n`);
    throw new CliUserError(msg);
  }
  write(`Set defaults.model = ${toSingleLineDisplay(name)}\n`);
}

/**
 * No TTY and no argument: never block on a prompt that can't be answered.
 * Surface the current and available models, then fail with guidance to pass an
 * explicit `<name>` so automation gets an actionable, non-zero result.
 */
async function reportModelsNonInteractive(
  write: Writer,
  writeError: Writer,
  discoverModels: typeof discoverAvailableModels,
): Promise<never> {
  const config = await loadConfig();
  write(`Current default model: ${toSingleLineDisplay(config.defaults.model)}\n\n`);

  const discovery: ModelDiscoveryResult = await discoverModels();
  const models = orderModelsByPreference(discovery.models);
  if (discovery.source === "static") {
    write(
      "Warning: Live model discovery failed, so Council is showing a built-in fallback list.\n\n",
    );
  }
  writeModelList(
    write,
    models.map((model) => toSingleLineDisplay(model)),
  );

  const msg = "Non-interactive mode: run 'council config model <name>' with an explicit model id.";
  writeError(`${msg}\n`);
  throw new CliUserError(msg);
}

/** Run the same numbered model picker the wizard uses and persist the choice. */
async function runModelPicker(
  write: Writer,
  output: NodeJS.WritableStream,
  input: TtyReadableStream | undefined,
  discoverModels: typeof discoverAvailableModels,
): Promise<void> {
  const rl = createInterface({
    input: input ?? process.stdin,
    output,
    terminal: false,
  });
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const next = await lines.next();
    if (next.done === true) {
      throw new CliUserError("Model selection aborted before completion.");
    }
    return next.value;
  };

  try {
    const model = await promptForModel(nextLine, write, output, discoverModels);
    await updateConfigField("defaults.model", model);
  } finally {
    rl.close();
  }
}

function buildModelCommand(
  write: Writer,
  writeError: Writer,
  wizardDeps?: ConfigWizardDependencies,
): Command {
  const cmd = new Command("model");
  cmd
    .description(
      "Set the default AI model — pass <name>, or omit it on a terminal for an interactive picker",
    )
    .argument("[name]", "Model id to set (omit on a TTY to pick interactively)")
    .action(async (name: string | undefined) => {
      const discoverModels = wizardDeps?.discoverModels ?? discoverAvailableModels;

      if (name !== undefined) {
        await setModelByName(name, write, writeError);
        return;
      }

      const input = wizardDeps?.input;
      if (!isInteractiveInput(input)) {
        await reportModelsNonInteractive(write, writeError, discoverModels);
        return;
      }

      const output = wizardDeps?.output ?? process.stdout;
      try {
        await runModelPicker(write, output, input, discoverModels);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const displayMsg = toSingleLineDisplay(msg);
        writeError(`${displayMsg}\n`);
        throw err instanceof CliUserError ? err : new CliUserError(displayMsg);
      }
    });
  return cmd;
}

export function buildConfigCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
  editorRunner?: EditorRunner,
  wizardDeps?: ConfigWizardDependencies,
): Command {
  const cmd = new Command("config");
  cmd.description("View and edit Council configuration");
  cmd.addCommand(buildShowCommand(write));
  cmd.addCommand(buildPathCommand(write));
  cmd.addCommand(buildEditCommand(write, writeError, editorRunner));
  cmd.addCommand(buildSetCommand(write, writeError));
  cmd.addCommand(buildModelCommand(write, writeError, wizardDeps));
  cmd.addCommand(buildWizardCommand(write, writeError, wizardDeps));
  return cmd;
}

/**
 * `council config show|path|edit` — config discoverability subcommands.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Command } from "commander";
import * as yaml from "yaml";

import {
  ConfigSchema,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  updateConfigField,
} from "../../config/index.js";
import { CliUserError } from "../cli-user-error.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const CONFIG_FILE = "config.yaml";
const SETTABLE_CONFIG_KEYS = [
  "defaults.model",
  "defaults.engine",
  "defaults.maxRounds",
  "defaults.maxExperts",
  "defaults.maxWordsPerResponse",
  "documents.aiExtraction",
  "documents.maxFileSizeMB",
] as const;

type SettableConfigKey = (typeof SETTABLE_CONFIG_KEYS)[number];

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

    write(`Config path: ${configFilePath}\n`);
    write(`Council home: ${councilHome}\n`);
    write(`Data home: ${dataHome}\n`);
    write(`Experts directory: ${expertsDir}\n`);
    write(`Panels directory: ${panelsDir}\n`);
    write(`Database: ${dbPath}\n\n`);
    write("Effective values:\n");

    const entries: [string, unknown, string][] = [
      ["defaults.model", config.defaults.model, sources.get("defaults.model") ?? "default"],
      ["defaults.engine", config.defaults.engine, sources.get("defaults.engine") ?? "default"],
      [
        "defaults.maxRounds",
        config.defaults.maxRounds,
        sources.get("defaults.maxRounds") ?? "default",
      ],
      [
        "defaults.maxExperts",
        config.defaults.maxExperts,
        sources.get("defaults.maxExperts") ?? "default",
      ],
      [
        "defaults.maxWordsPerResponse",
        config.defaults.maxWordsPerResponse,
        sources.get("defaults.maxWordsPerResponse") ?? "default",
      ],
    ];

    const keyWidth = Math.max(...entries.map(([k]) => k.length));
    for (const [key, value, source] of entries) {
      write(`  ${key.padEnd(keyWidth)}  ${String(value).padEnd(24)} (${source})\n`);
    }
  });
  return cmd;
}

function buildPathCommand(write: Writer): Command {
  const cmd = new Command("path");
  cmd.description("Print the config file path (useful for scripts)").action(() => {
    write(getConfigFilePath() + "\n");
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
      // Restore original config on YAML parse failure
      await fs.writeFile(configFilePath, originalContents, "utf-8");
      const msg = `YAML parse error: ${err instanceof Error ? err.message : String(err)}`;
      writeError(`Validation failed: ${msg}\n`);
      writeError("Original config has been restored.\n");
      throw new CliUserError(msg);
    }

    const result = ConfigSchema.safeParse(parsed ?? {});
    if (!result.success) {
      // Restore original config on schema validation failure
      await fs.writeFile(configFilePath, originalContents, "utf-8");
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      writeError(`Validation failed:\n${issues}\n`);
      writeError("Original config has been restored.\n");
      throw new CliUserError("Config validation failed after edit");
    }

    write("Config saved and valid.\n");
  });
  return cmd;
}

function isSettableConfigKey(key: string): key is SettableConfigKey {
  return SETTABLE_CONFIG_KEYS.includes(key as SettableConfigKey);
}

function coerceConfigValue(key: SettableConfigKey, rawValue: string): string | number {
  switch (key) {
    case "defaults.maxRounds":
    case "defaults.maxExperts":
    case "defaults.maxWordsPerResponse": {
      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed)) {
        throw new CliUserError(`Config value for ${key} must be an integer.`);
      }
      return parsed;
    }
    case "documents.aiExtraction": {
      const validValues = ["off", "ask", "auto"] as const;
      if (!validValues.includes(rawValue as (typeof validValues)[number])) {
        throw new CliUserError(
          `Config value for ${key} must be one of: ${validValues.join(", ")}`,
        );
      }
      return rawValue;
    }
    case "documents.maxFileSizeMB": {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
        throw new CliUserError(
          `Config value for ${key} must be a number between 1 and 500.`,
        );
      }
      return parsed;
    }
    default:
      return rawValue;
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
        const msg = `Unsupported config key "${key}". Valid keys:\n  - ${SETTABLE_CONFIG_KEYS.join("\n  - ")}`;
        writeError(`${msg}\n`);
        throw new CliUserError(msg);
      }

      let value: string | number;
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

      write(`Set ${key} = ${String(value)}\n`);
    });
  return cmd;
}

export function buildConfigCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
  editorRunner?: EditorRunner,
): Command {
  const cmd = new Command("config");
  cmd.description("View and edit Council configuration");
  cmd.addCommand(buildShowCommand(write));
  cmd.addCommand(buildPathCommand(write));
  cmd.addCommand(buildEditCommand(write, writeError, editorRunner));
  cmd.addCommand(buildSetCommand(write, writeError));
  return cmd;
}

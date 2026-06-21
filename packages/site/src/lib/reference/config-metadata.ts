/**
 * Curated, editorial metadata for the generated config & environment reference.
 *
 * The Zod `ConfigSchema` is the source of truth for every key, type, default,
 * and constraint; this module supplies the human-friendly prose that the schema
 * itself does not carry. {@link CONFIG_DESCRIPTIONS} is keyed by section name
 * (e.g. `defaults`) and by full dot-path (e.g. `defaults.model`). Every leaf key
 * MUST have an entry — {@link buildConfigModel} throws otherwise — so a new
 * schema key cannot ship without documentation.
 *
 * {@link ENV_VARS} is the canonical registry of every environment variable a
 * user can set to configure Council. A test scans the CLI source for
 * `process.env` reads and fails if any (other than {@link IGNORED_ENV_VARS})
 * is missing here, so the environment docs cannot silently fall out of sync.
 */
import type { EnvVarModel } from "./config-model";

export const CONFIG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  defaults: "Global defaults applied to every panel unless overridden per-panel or per-command.",
  "defaults.model": "Provider-agnostic model identifier used when a panel does not specify one.",
  "defaults.engine": "Engine used when the --engine flag is not passed on the command line.",
  "defaults.maxRounds": "Maximum number of debate rounds per panel.",
  "defaults.maxExperts": "Maximum number of experts per panel.",
  "defaults.maxWordsPerResponse": "Soft per-expert response cap, measured in words.",

  telemetry: "Opt-in, anonymous usage telemetry.",
  "telemetry.enabled":
    "Enable anonymous usage telemetry (command names only, never panel content).",

  providers:
    "Per-provider settings for engines that authenticate with a standalone API key. Only the NAME of the environment variable holding the key is stored here, never the key value itself.",
  "providers.openai.apiKeyEnvVar":
    "Name of the environment variable holding the OpenAI API key, never the key value itself.",
  "providers.anthropic.apiKeyEnvVar":
    "Name of the environment variable holding the Anthropic API key, never the key value itself.",

  expert: "Expert-library settings governing document ingestion and memory decay.",
  "expert.backgroundProcessing": "Enable background document indexing for expert libraries.",
  "expert.recencyHalfLifeDays": "Number of days until an expert's memory weights decay by half.",
  "expert.supportedFormats": "File extensions eligible for expert document ingestion.",

  documents:
    "Document-extraction settings, including the optional AI-extraction fallback and the file-size ceiling.",
  "documents.aiExtraction":
    "AI-based text-extraction fallback for unknown or unsupported file formats.",
  "documents.aiExtractionAllowedExtensions":
    "Whitelist of extensions eligible for AI extraction; an empty list means every extension is eligible.",
  "documents.maxFileSizeMB":
    "Maximum file size accepted by the document extractor, measured in megabytes.",

  chat: "Chat-mode context management and summarization.",
  "chat.recentTurnCount": "Number of recent chat turns kept verbatim before summarization.",
  "chat.summaryMaxWords": "Maximum length, in words, of the rolling chat-history summary.",
  "chat.longConversationWarning": "Warn the user once a chat exceeds this many turns.",

  conclude: "Synthesis settings for the council conclude command.",
  "conclude.maxTranscriptChars":
    "Character budget for transcript content in the synthesis prompt; older turns are dropped beyond it.",

  paths: "User-facing data directory locations.",
  "paths.dataHome": "Directory holding user-facing expert and panel YAML files.",
};

export const ENV_VARS: readonly EnvVarModel[] = [
  {
    name: "COUNCIL_HOME",
    purpose:
      "Override the runtime directory that stores Council's database, logs, and config.yaml. Used by --ephemeral mode and tests to isolate state.",
    default: "~/.council/",
  },
  {
    name: "COUNCIL_DATA_HOME",
    purpose:
      "Override the data directory for expert and panel YAML files. Takes precedence over paths.dataHome.",
    default: "~/Council/",
  },
  {
    name: "NO_COLOR",
    purpose:
      "Disable ANSI color output when set to any non-empty value (follows the NO_COLOR standard).",
    default: "(unset)",
  },
  {
    name: "COUNCIL_ASCII",
    purpose:
      "Force an ASCII-only charset (set to 1), disabling Unicode box-drawing characters and emoji.",
    default: "(unset)",
  },
  {
    name: "COPILOT_CLI_PATH",
    purpose: "Override the auto-detected path to the GitHub Copilot CLI loader.",
    default: "auto-detected",
  },
  {
    name: "TERM",
    purpose:
      "Standard terminal type; the value dumb switches Council to ASCII-only, no-color output.",
    default: "auto-detected",
  },
  {
    name: "CI",
    purpose: "When set to true or 1, forces non-interactive rendering with no prompts or spinners.",
    default: "(unset)",
  },
  {
    name: "ACCESSIBILITY",
    purpose: "When set to 1, forces non-interactive, screen-reader-friendly rendering.",
    default: "(unset)",
  },
  {
    name: "VISUAL",
    purpose:
      "Editor launched by council config edit and other edit commands; checked before EDITOR.",
    default: "(unset)",
  },
  {
    name: "EDITOR",
    purpose: "Fallback editor launched by edit commands when VISUAL is unset.",
    default: "(unset)",
  },
];

/**
 * Environment variables read by the CLI that are intentionally not part of the
 * user-facing configuration surface (internal detection only).
 */
export const IGNORED_ENV_VARS: readonly string[] = ["npm_config_user_agent"];

/**
 * Configuration schema for Council.
 *
 * Defaults are conservative — fewer experts and rounds than the upper limit
 * so a fresh user's first `council convene` doesn't burn a 30-premium-request
 * panel by accident (see DECISIONS.md ADR-001 on Copilot subscription billing).
 *
 * No API keys here: Council uses the user's GitHub Copilot auth (via
 * @github/copilot-sdk). The `model` field is a provider-agnostic identifier;
 * the engine adapter translates to the provider-native name.
 */
import { z } from "zod";

export const DEFAULT_MODEL = "claude-sonnet-4.5";

export const ENGINE_CHOICES = ["copilot", "mock"] as const;
export type EngineChoice = (typeof ENGINE_CHOICES)[number];

export const ConfigSchema = z
  .object({
    defaults: z
      .object({
        /** Provider-agnostic model id (e.g. "claude-sonnet-4.5"). */
        model: z.string().min(1).default(DEFAULT_MODEL),
        /** Engine to use when --engine is not specified on the CLI. */
        engine: z.enum(ENGINE_CHOICES).default("copilot"),
        /** Maximum debate rounds; 1..20 inclusive. */
        maxRounds: z.number().int().min(1).max(20).default(4),
        /** Maximum experts per panel; 2..8 inclusive. */
        maxExperts: z.number().int().min(2).max(8).default(3),
        /** Soft per-expert response cap (words); 50..2000 inclusive. */
        maxWordsPerResponse: z.number().int().min(50).max(2000).default(250),
      })
      .default({
        model: DEFAULT_MODEL,
        engine: "copilot",
        maxRounds: 4,
        maxExperts: 3,
        maxWordsPerResponse: 250,
      }),
    telemetry: z
      .object({
        /** Opt-in only. Names of commands invoked, no content. */
        enabled: z.boolean().default(false),
      })
      .default({ enabled: false }),
    /**
     * Expert library settings — govern how experts ingest sources and
     * decay memory weights over time. Background processing is off by
     * default to keep first-run behavior predictable.
     */
    expert: z
      .object({
        backgroundProcessing: z.boolean().default(false),
        recencyHalfLifeDays: z.number().int().min(1).max(365).default(90),
        supportedFormats: z
          .array(z.string())
          .default([
            ".md",
            ".txt",
            ".html",
            ".pdf",
            ".csv",
            ".tsv",
            ".rtf",
            ".docx",
            ".pptx",
            ".xlsx",
            ".xls",
            ".odt",
            ".ods",
            ".odp",
          ]),
      })
      .default({
        backgroundProcessing: false,
        recencyHalfLifeDays: 90,
        supportedFormats: [
          ".md",
          ".txt",
          ".html",
          ".pdf",
          ".csv",
          ".tsv",
          ".rtf",
          ".docx",
          ".pptx",
          ".xlsx",
          ".xls",
          ".odt",
          ".ods",
          ".odp",
        ],
      }),
    /**
     * Document-extraction settings: govern when (if ever) Council falls
     * back to AI-based text extraction for unknown or unsupported file
     * formats, and the maximum file size accepted by the extractor.
     * Defaults are conservative — `aiExtraction` is `off`, so no
     * surprise AI calls on first run.
     */
    documents: z
      .object({
        /**
         * AI-extraction fallback mode:
         *   - `off`  — never use AI extraction (default).
         *   - `ask`  — prompt the user before AI extraction.
         *   - `auto` — automatically use AI extraction for unknown formats.
         */
        aiExtraction: z.enum(["off", "ask", "auto"]).default("off"),
        /**
         * Whitelist of file extensions eligible for AI extraction. An
         * empty array means "all extensions are eligible" when
         * `aiExtraction` is `ask` or `auto`.
         */
        aiExtractionAllowedExtensions: z.array(z.string()).default([]),
        /**
         * Maximum file size (MB) accepted by the document extractor.
         * Files exceeding this ceiling are rejected with
         * `oversize-file` before any read takes place. 1..500 inclusive,
         * default 50.
         */
        maxFileSizeMB: z.number().min(1).max(500).default(50),
      })
      .default({
        aiExtraction: "off",
        aiExtractionAllowedExtensions: [],
        maxFileSizeMB: 50,
      }),
    /**
     * Chat-mode tuning: how much recent context to keep verbatim, how
     * aggressively to summarize, and when to warn the user about long
     * conversations.
     */
    chat: z
      .object({
        recentTurnCount: z.number().int().min(5).max(50).default(10),
        summaryMaxWords: z.number().int().min(100).max(2000).default(500),
        longConversationWarning: z.number().int().min(50).max(10000).default(500),
      })
      .default({
        recentTurnCount: 10,
        summaryMaxWords: 500,
        longConversationWarning: 500,
      }),
    /**
     * User-facing data directory paths. `dataHome` holds expert and panel
     * YAML files (separate from the hidden `~/.council/` runtime dir).
     */
    paths: z
      .object({
        dataHome: z.string().default("~/Council"),
      })
      .default({ dataHome: "~/Council" }),
  })
  .default({
    defaults: {
      model: DEFAULT_MODEL,
      engine: "copilot",
      maxRounds: 4,
      maxExperts: 3,
      maxWordsPerResponse: 250,
    },
    telemetry: { enabled: false },
    expert: {
      backgroundProcessing: false,
      recencyHalfLifeDays: 90,
      supportedFormats: [
        ".md",
        ".txt",
        ".html",
        ".pdf",
        ".csv",
        ".tsv",
        ".rtf",
        ".docx",
        ".pptx",
        ".xlsx",
        ".xls",
        ".odt",
        ".ods",
        ".odp",
      ],
    },
    documents: {
      aiExtraction: "off",
      aiExtractionAllowedExtensions: [],
      maxFileSizeMB: 50,
    },
    chat: {
      recentTurnCount: 10,
      summaryMaxWords: 500,
      longConversationWarning: 500,
    },
    paths: { dataHome: "~/Council" },
  });

export type CouncilConfig = z.infer<typeof ConfigSchema>;

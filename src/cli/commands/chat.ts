/**
 * `council chat <expert-slug>` (Roadmap 5.2) — persistent 1:1 chat with
 * an expert from the library.
 *
 * Subcommand-less: behavior is selected by flags on a single Commander
 * action so that `council chat <slug>`, `council chat --list`, and
 * `council chat <slug> --history` share one entry point.
 *
 * Interactive readline is wrapped behind a `ChatInputProvider` injection
 * seam so unit tests can drive the loop with scripted lines without
 * spinning up a real TTY. The default provider wraps
 * `node:readline/promises` over stdin/stdout.
 *
 * The engine layer's `send()` only accepts a single `prompt: string`
 * (the system message is set once per expert at registration), so prior
 * conversation history is folded into each turn's prompt by
 * `buildChatTurnPrompt`. Only the most recent
 * `config.chat.recentTurnCount` turns are included verbatim — older
 * turns will be summarized in a future increment (Roadmap 5.3).
 */
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";

import { Command } from "commander";
import { ulid } from "ulid";

import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  DEFAULT_MODEL,
  type CouncilConfig,
} from "../../config/index.js";
import type { ChatSession, ChatTurn } from "../../core/chat/chat-session.js";
import type { ExpertDefinition } from "../../core/expert.js";
import { FileExpertLibrary } from "../../core/expert-library.js";
import { buildSystemPrompt } from "../../core/prompt-builder.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import type { CouncilDatabase } from "../../memory/db.js";
import { createDatabase } from "../../memory/db.js";
import { ChatRepository } from "../../memory/repositories/chat-repository.js";

import { createChatRenderer, type ChatRenderer } from "../renderers/chat-renderer.js";
import type { Sink } from "../renderers/types.js";
import { formatEngineError } from "../error-mapper.js";
import { ENGINE_KINDS, type EngineKind, makeEngineFromKind } from "../run-with-engine.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const CHAT_TASK_DESCRIPTION =
  "You are in a persistent 1:1 conversation. Respond naturally and helpfully. " +
  "Reference prior conversation context when relevant.";

const EXIT_TOKENS = new Set(["exit", "/quit", "quit", "/exit"]);

/**
 * Single-line input source used by the interactive chat loop. Returning
 * `null` signals end-of-input (Ctrl+D, scripted EOF, etc.) which the
 * loop treats as a graceful exit equivalent to `/quit`.
 */
export interface ChatInputProvider {
  readLine(): Promise<string | null>;
  close(): void;
}

export interface ChatCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  /**
   * Test seam: returns the input provider used by the interactive loop.
   * Defaults to a `node:readline/promises` interface over stdin/stdout.
   */
  readonly inputProvider?: () => ChatInputProvider;
}

interface ChatRunOptions {
  readonly engine?: EngineKind;
  readonly new?: boolean;
  readonly list?: boolean;
  readonly history?: boolean;
}

export function buildChatCommand(deps: ChatCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("chat");
  cmd
    .description("Persistent conversation with an expert from the library")
    .argument("[target]", "Expert slug to chat with")
    .option(
      "--engine <kind>",
      `Engine: ${ENGINE_KINDS.join(" | ")} (required for interactive chat)`,
    )
    .option("--new", "Archive the active conversation and start a fresh one")
    .option("--list", "List all chat conversations and exit")
    .option("--history", "Show archived conversations for the target")
    .action(async (target: string | undefined, raw: ChatRunOptions) => {
      if (raw.list) {
        await runList(write);
        return;
      }
      if (raw.history) {
        if (!target) {
          throw new Error("--history requires a target (expert slug)");
        }
        await runHistory(target, write);
        return;
      }
      if (!target) {
        throw new Error("Missing required argument: <target> (expert slug)");
      }
      if (!raw.engine || !ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `--engine is required for interactive chat. Expected one of: ${ENGINE_KINDS.join(", ")}`,
        );
      }
      await runChat(target, raw, deps, write, writeError);
    });

  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────

export interface BuildChatTurnPromptOptions {
  readonly history: readonly ChatTurn[];
  readonly userMessage: string;
  readonly expertDisplayName: string;
}

/**
 * Render the per-turn prompt fed to `engine.send()`. The expert system
 * message is set once at registration via `buildSystemPrompt`, so the
 * conversation transcript is folded into each turn's prompt here.
 *
 * Pure: no I/O, no globals — exported so `chat.test.ts` can pin the
 * exact format.
 */
export function buildChatTurnPrompt(opts: BuildChatTurnPromptOptions): string {
  const { history, userMessage, expertDisplayName } = opts;
  if (history.length === 0) {
    return userMessage;
  }
  const lines: string[] = ["PRIOR CONVERSATION:"];
  for (const turn of history) {
    const speaker = turn.role === "user" ? "User" : expertDisplayName;
    lines.push(`${speaker}: ${turn.content}`);
  }
  lines.push("");
  lines.push(`USER: ${userMessage}`);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// --list
// ──────────────────────────────────────────────────────────────────────

async function runList(write: Writer): Promise<void> {
  await withChatRepository(async (repo) => {
    const sessions = await repo.listSessions();
    if (sessions.length === 0) {
      write('No chat conversations yet. Start one with "council chat <expert-slug>".\n');
      return;
    }
    const rows = await Promise.all(
      sessions.map(async (s) => {
        const count = await repo.getTurnCount(s.id);
        return [s.targetSlug, String(count), formatDate(s.updatedAt), s.status] as const;
      }),
    );
    const header = ["target", "messages", "last active", "status"] as const;
    writeTable(header, rows, write);
  });
}

// ──────────────────────────────────────────────────────────────────────
// --history
// ──────────────────────────────────────────────────────────────────────

async function runHistory(target: string, write: Writer): Promise<void> {
  await withChatRepository(async (repo) => {
    const archived = await repo.listSessions({ targetSlug: target, status: "archived" });
    if (archived.length === 0) {
      write(`No archived conversations for "${target}".\n`);
      return;
    }
    const rows = await Promise.all(
      archived.map(async (s) => {
        const count = await repo.getTurnCount(s.id);
        return [
          s.id,
          String(count),
          formatDate(s.createdAt),
          formatDate(s.updatedAt),
          s.status,
        ] as const;
      }),
    );
    const header = ["session id", "messages", "started", "last active", "status"] as const;
    writeTable(header, rows, write);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Interactive chat
// ──────────────────────────────────────────────────────────────────────

async function runChat(
  target: string,
  raw: ChatRunOptions,
  deps: ChatCommandDeps,
  write: Writer,
  writeError: Writer,
): Promise<void> {
  const engineKind = raw.engine as EngineKind;
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);

  try {
    const library = new FileExpertLibrary(dataHome, db);
    const expert = await library.get(target);
    if (!expert) {
      const available = (await library.list()).map((e) => e.slug);
      const list =
        available.length > 0
          ? available.join(", ")
          : "(none — create one with `council expert create`)";
      writeError(`Expert "${target}" not found. Available experts: ${list}\n`);
      throw new Error(`Expert "${target}" not found`);
    }

    const repo = new ChatRepository(db);

    // Resolve which session we'll use, but defer mutations (archive/create
    // for --new) until AFTER engine startup succeeds so a failed
    // `engine.start()` / `addExpert()` doesn't leave the user with a
    // freshly-archived prior session and an empty replacement.
    const existingActive = await repo.findActiveSession("expert", target);
    let priorToArchive: ChatSession | undefined;
    let resumingSession: ChatSession | undefined;
    let willCreateFresh = false;
    if (raw.new) {
      priorToArchive = existingActive;
      willCreateFresh = true;
    } else if (existingActive) {
      resumingSession = existingActive;
    } else {
      willCreateFresh = true;
    }

    const renderer = createChatRenderer({
      sink: makeSink(write, writeError),
      experts: new Map([[expert.slug, expert.displayName]]),
    });

    const engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(engineKind);
    const inputProvider = (deps.inputProvider ?? defaultInputProvider)();

    try {
      await engine.start();
      const expertSpec = buildExpertSpec(expert, config);
      await engine.addExpert(expertSpec);

      // Engine ready — NOW it's safe to mutate persistent chat state.
      let session: ChatSession;
      if (raw.new && priorToArchive) {
        await repo.archiveSession(priorToArchive.id);
        renderer.showSystem("Previous conversation archived. Starting fresh...", "info");
      }
      if (willCreateFresh) {
        session = await repo.createSession({ targetType: "expert", targetSlug: target });
        renderer.showSessionStatus(`Starting new conversation with ${expert.displayName}...`);
      } else if (resumingSession) {
        session = resumingSession;
        const existingCount = await repo.getTurnCount(session.id);
        renderer.showSessionStatus(
          `Resuming conversation with ${expert.displayName} (${existingCount} messages, last active ${formatDate(session.updatedAt)})...`,
        );
      } else {
        // Defensive — the dispatch above always sets one of the two flags.
        throw new Error("internal: chat session resolution failed");
      }

      await runInteractiveLoop({
        engine,
        expertSpec,
        expert,
        session,
        repo,
        renderer,
        inputProvider,
        config,
        writeError,
      });
    } catch (err: unknown) {
      writeError("\n" + formatEngineError(err as Error) + "\n\n");
      throw err;
    } finally {
      inputProvider.close();
      await engine.stop().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        writeError(`!! engine.stop() failed during cleanup: ${msg}\n`);
      });
    }
  } finally {
    await db.destroy().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
    });
  }
}

interface InteractiveLoopOptions {
  readonly engine: CouncilEngine;
  readonly expertSpec: ExpertSpec;
  readonly expert: ExpertDefinition;
  readonly session: ChatSession;
  readonly repo: ChatRepository;
  readonly renderer: ChatRenderer;
  readonly inputProvider: ChatInputProvider;
  readonly config: CouncilConfig;
  readonly writeError: Writer;
}

async function runInteractiveLoop(opts: InteractiveLoopOptions): Promise<void> {
  const { engine, expertSpec, expert, session, repo, renderer, inputProvider, config, writeError } =
    opts;
  const recentLimit = config.chat.recentTurnCount;

  while (true) {
    renderer.showPrompt();
    const line = await inputProvider.readLine();
    if (line === null) {
      renderer.showSystem("Conversation saved.", "info");
      return;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (EXIT_TOKENS.has(trimmed.toLowerCase())) {
      renderer.showSystem("Conversation saved.", "info");
      return;
    }

    await repo.addTurn({ chatId: session.id, role: "user", content: trimmed });

    // Fetch only the recent tail (avoid re-reading the full transcript on
    // every turn). The just-inserted user turn IS included; we drop it
    // from `history` since it gets re-rendered in the prompt.
    const latestSeq = await repo.getLatestSeq(session.id);
    const after = Math.max(0, latestSeq - recentLimit - 1);
    const recent = await repo.getTurns(session.id, { afterSeq: after, limit: recentLimit + 1 });
    const history = recent.slice(0, -1);
    const prompt = buildChatTurnPrompt({
      history,
      userMessage: trimmed,
      expertDisplayName: expert.displayName,
    });

    let assembled = "";
    let failed = false;
    let recoverable = false;
    let lastError = "";
    // Buffer chunks during each attempt — only flush to the renderer
    // after a successful attempt completes. This prevents partial deltas
    // from a failed first attempt from being double-rendered when the
    // retry runs (PRD §F4).
    const attempt = async (): Promise<void> => {
      assembled = "";
      failed = false;
      recoverable = false;
      lastError = "";
      try {
        for await (const evt of engine.send({ prompt, expertId: expertSpec.id })) {
          if (evt.kind === "message.delta") {
            assembled += evt.text;
          } else if (evt.kind === "error") {
            failed = true;
            recoverable = evt.recoverable;
            lastError = evt.error.message;
          }
        }
      } catch (err: unknown) {
        failed = true;
        recoverable = false;
        lastError = err instanceof Error ? err.message : String(err);
      }
    };

    await attempt();
    if (failed && recoverable) {
      // One retry per PRD §F4. Surface the retry to the user so the UX
      // doesn't appear frozen during the second attempt.
      renderer.showSystem("Transient error from engine. Retrying once...", "warn");
      await attempt();
    }

    if (!failed && assembled.length > 0) {
      renderer.startExpertResponse(expert.slug);
      renderer.streamChunk(assembled);
      renderer.endExpertResponse();
    }

    if (failed) {
      writeError(formatEngineError({ code: "PROVIDER_ERROR", message: lastError }) + "\n");
      renderer.showSystem(
        "Failed to get response. Your message has been saved. Try again.",
        "warn",
      );
      continue;
    }

    if (assembled.length === 0) {
      renderer.showSystem("Empty response from engine. Your message has been saved.", "warn");
      continue;
    }

    await repo.addTurn({
      chatId: session.id,
      role: "expert",
      expertSlug: expert.slug,
      content: assembled,
    });
  }
}

function buildExpertSpec(expert: ExpertDefinition, config: CouncilConfig): ExpertSpec {
  const systemMessage = buildSystemPrompt(expert, undefined, CHAT_TASK_DESCRIPTION);
  return {
    id: ulid(),
    slug: expert.slug,
    displayName: expert.displayName,
    model: expert.model ?? config.defaults.model ?? DEFAULT_MODEL,
    systemMessage,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function withChatRepository(
  fn: (repo: ChatRepository, db: CouncilDatabase) => Promise<void>,
): Promise<void> {
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);
  try {
    await fn(new ChatRepository(db), db);
  } finally {
    await db.destroy();
  }
}

function makeSink(write: Writer, writeError: Writer): Sink {
  return {
    write: (text: string) => write(text),
    writeError: (text: string) => writeError(text),
  };
}

function defaultInputProvider(): ChatInputProvider {
  const rl = readline.createInterface({ input: defaultStdin, output: defaultStdout });
  return {
    async readLine(): Promise<string | null> {
      try {
        return await rl.question("");
      } catch {
        // Closed (Ctrl+C / Ctrl+D) — treat as EOF.
        return null;
      }
    },
    close(): void {
      rl.close();
    },
  };
}

function formatDate(iso: string): string {
  // Minimal display: keep the ISO `YYYY-MM-DD HH:MM` slice for both
  // table and resume banners. Avoids locale variance in tests.
  if (iso.length >= 16) {
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return iso;
}

function writeTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  write: Writer,
): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  write(header.map((h, i) => pad(h, widths[i] ?? 0)).join("  ") + "\n");
  write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
  for (const row of rows) {
    write(row.map((c, i) => pad(c, widths[i] ?? 0)).join("  ") + "\n");
  }
}

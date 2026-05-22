/**
 * Chat command entry point — builds the Commander command and routes to
 * the appropriate handler (expert vs panel, list, history).
 */
import { Command, Option } from "commander";
import * as path from "node:path";

import {
  isInteractiveTerminal,
  expertFromCachedRow,
  CliUserError,
  FileExpertLibrary,
  ExpertLibraryRepository,
  PanelNotFoundError,
  loadPanel,
  suggestMatch,
  createDatabase,
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  resolveEngine,
  ENGINE_KINDS,
  type ChatCommandDeps,
  type ChatRunOptions,
  type EngineKind,
  type Writer,
  type PanelDefinition,
} from "./shared.js";
import { defaultWriter, defaultErrorWriter } from "../writer.js";
import { runList } from "./list.js";
import { runHistory } from "./history.js";
import { runExpertChat } from "./expert-chat.js";
import { runPanelChat } from "./panel-chat.js";

// Re-export everything that external consumers (tests, bin/council.ts) use
export { isInteractiveTerminal } from "./shared.js";
export { buildChatTurnPrompt } from "./shared.js";
export { buildPanelTurnPrompt } from "./shared.js";
export { appendReferenceDocuments } from "./shared.js";
export { safeRetrieveSnippets } from "./shared.js";
export { safeGetContext } from "./shared.js";
export { safeMaybeSummarize } from "./shared.js";
export { createSummarizationGate } from "./shared.js";
export { rewriteRotateError } from "./shared.js";
export { SAFE_MAYBE_SUMMARIZE_TIMEOUT_MS } from "./shared.js";
export { LONG_CONVERSATION_CHECK_DISABLED } from "./shared.js";
export type {
  ChatInputProvider,
  ChatCommandDeps,
  BuildChatTurnPromptOptions,
  BuildPanelTurnPromptOptions,
  SummarizationGate,
} from "./shared.js";

export function buildChatCommand(deps: ChatCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("chat");
  cmd
    .description(
      "Persistent conversation with an expert or panel from the library. " +
        "For structured debates use `council convene`.",
    )
    .argument("[target]", "Expert slug or panel name to chat with")
    .addOption(
      new Option("--engine <kind>", "Engine to use (default: from config)").choices([
        ...ENGINE_KINDS,
      ]),
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
          throw new Error("--history requires a target (expert slug or panel name)");
        }
        await runHistory(target, write, writeError);
        return;
      }
      if (!target) {
        throw new Error("Missing required argument: <target> (expert slug or panel name)");
      }
      const config = await loadConfig();
      const engineResolved = resolveEngine(raw.engine, config);
      await runChat(target, { ...raw, engine: engineResolved }, deps, write, writeError);
    });

  cmd.addHelpText(
    "after",
    `
Examples:
  $ council chat security-auditor --engine copilot               # 1:1 with an expert
  $ council chat architecture-review --engine copilot            # group chat with a panel
  $ council chat --list                                          # list all chat sessions
`,
  );

  return cmd;
}

async function runChat(
  target: string,
  raw: ChatRunOptions,
  deps: ChatCommandDeps,
  write: Writer,
  writeError: Writer,
): Promise<void> {
  if (!deps.inputProvider && !isInteractiveTerminal(process.stdin.isTTY)) {
    throw new CliUserError(
      "council chat requires an interactive terminal. Use `council ask` for non-interactive queries.",
    );
  }

  const engineKind = raw.engine as EngineKind;
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);

  try {
    const library = new FileExpertLibrary(dataHome, db);
    let expert = await library.get(target);
    if (!expert) {
      const libRepo = new ExpertLibraryRepository(db);
      const cached = await libRepo.findBySlug(target);
      if (cached) {
        write(
          `\u26A0 Expert file "${target}.yaml" not found. Using cached definition from database.\n`,
        );
        expert = expertFromCachedRow(cached);
      }
    }
    if (expert) {
      await runExpertChat({
        target,
        expert,
        raw,
        deps,
        write,
        writeError,
        config,
        db,
        engineKind,
        dataHome,
      });
      return;
    }

    let panel: PanelDefinition | undefined;

    // Check if target exists as a convene-generated panel in the DB first.
    // Convene-generated panel names include timestamps (e.g., "code-review-2026-05-22T05:30:01")
    // which violate the slug regex, so we look them up in the DB before attempting file-based lookup.
    const { PanelRepository } = await import("../../../memory/repositories/panels.js");
    const panelRepo = new PanelRepository(db);
    const dbPanel = await panelRepo.findByName(target);

    if (dbPanel) {
      // Found a panel in the DB. Extract its template name and load that panel definition.
      try {
        const configParsed = JSON.parse(dbPanel.configJson) as { template?: string };
        const templateName = configParsed.template;
        if (!templateName) {
          throw new Error(`Panel "${target}" has no template name in configJson`);
        }
        panel = await loadPanel(templateName, dataHome);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        writeError(
          `!! Warning: panel "${target}" exists in database but failed to load its template: ${msg}\n`,
        );
        throw new CliUserError(`Failed to load panel template for "${target}"`);
      }
    } else {
      // No panel in the DB, try loading from YAML files (user panels or built-in templates).
      try {
        panel = await loadPanel(target, dataHome);
      } catch (err: unknown) {
        if (err instanceof PanelNotFoundError) {
          const available = (await library.list()).map((e) => e.slug);
          const suggestions = suggestMatch(target, available);
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
          const list =
            available.length > 0
              ? available.join(", ")
              : "(none — create one with `council expert create`)";
          writeError(`"${target}" not found as expert or panel.${hint} Available experts: ${list}\n`);
          throw new CliUserError(`"${target}" not found`);
        }
        throw err;
      }
    }

    await runPanelChat({
      target,
      panel,
      library,
      raw,
      deps,
      write,
      writeError,
      config,
      db,
      engineKind,
      dataHome,
    });
  } finally {
    await db.destroy().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
    });
  }
}

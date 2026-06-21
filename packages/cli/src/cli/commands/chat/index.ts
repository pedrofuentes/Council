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
  parseStoredPanelDefinition,
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
  type CouncilDatabase,
  type ExpertDefinition,
} from "./shared.js";
import { defaultWriter, defaultErrorWriter } from "../writer.js";
import { stripControlChars } from "../../strip-control-chars.js";
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
export { isExitCommand } from "./shared.js";
export { getStartupHelpText } from "./shared.js";
export { SAFE_MAYBE_SUMMARIZE_TIMEOUT_MS } from "./shared.js";
export { LONG_CONVERSATION_CHECK_DISABLED } from "./shared.js";
export type {
  ChatInputProvider,
  ChatCommandDeps,
  BuildChatTurnPromptOptions,
  BuildPanelTurnPromptOptions,
  SummarizationGate,
} from "./shared.js";

function readTemplateName(configJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || !("template" in parsed)) {
    return undefined;
  }
  const template = (parsed as { readonly template: unknown }).template;
  return typeof template === "string" && template.length > 0 ? template : undefined;
}

function loadPersistedPanelDefinition(
  target: string,
  configJson: string,
): PanelDefinition | undefined {
  const safeTarget = stripControlChars(target);
  const stored = parseStoredPanelDefinition(configJson);
  if (stored.kind === "ok") {
    return stored.definition;
  }
  if (stored.kind === "invalid") {
    throw new Error(`Stored panel definition for "${safeTarget}" is invalid: ${stored.message}`);
  }
  return undefined;
}

function legacyPanelRecoveryHint(topic: string | null): string {
  const safeTopic =
    typeof topic === "string" && topic.trim().length > 0 ? stripControlChars(topic) : null;
  const rerunHint =
    safeTopic === null
      ? "Re-run `council convene` for the original topic to recreate the panel."
      : `Re-run \`council convene "${safeTopic}"\` to recreate the panel for this topic.`;
  return (
    "This session predates persisted panel definitions, so its auto-composed panel cannot be " +
    `reloaded. ${rerunHint}`
  );
}

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

In panel chat sessions:
  @<slug> — address a specific expert by slug (e.g., @cfo, @cto)
  @convene <topic> — run a structured 4-phase debate inline

Panels come from your reusable library (see 'council panel list'). An
auto-composed 'council convene' session can be reopened directly; to keep one
as a reusable library panel, promote its session:
  $ council panel save <session> [name]
`,
  );

  return cmd;
}

/**
 * Validates that the target exists as an expert or panel and returns
 * resolution information. Throws CliUserError with a clear message if not found.
 * This runs BEFORE any TUI setup to ensure error messages reach stderr.
 */
async function validateAndResolveTarget(
  target: string,
  dataHome: string,
  db: CouncilDatabase,
  writeError: Writer,
): Promise<{ type: "expert" | "panel"; expert?: ExpertDefinition; panel?: PanelDefinition }> {
  const safeTarget = stripControlChars(target);
  const library = new FileExpertLibrary(dataHome, db);

  // Check for expert first (file or cached)
  let expert = await library.get(target);
  if (!expert) {
    const libRepo = new ExpertLibraryRepository(db);
    const cached = await libRepo.findBySlug(target);
    if (cached) {
      expert = expertFromCachedRow(cached);
    }
  }
  if (expert) {
    return { type: "expert", expert };
  }

  // Check if target exists as a convene-generated panel in the DB first.
  const { PanelRepository } = await import("../../../memory/repositories/panels.js");
  const panelRepo = new PanelRepository(db);
  const dbPanel = await panelRepo.findByName(target);

  if (dbPanel) {
    // Found a panel session in the DB. Prefer the reusable template; fall back
    // to the full definition persisted by auto-composed convene sessions.
    try {
      const templateName = readTemplateName(dbPanel.configJson);
      if (!templateName) {
        throw new Error(
          `Panel "${safeTarget}" has no template name in configJson. ${legacyPanelRecoveryHint(
            dbPanel.topic,
          )}`,
        );
      }
      try {
        const panel = await loadPanel(templateName, dataHome);
        return { type: "panel", panel };
      } catch (err: unknown) {
        if (!(err instanceof PanelNotFoundError)) {
          throw err;
        }
        const storedPanel = loadPersistedPanelDefinition(target, dbPanel.configJson);
        if (storedPanel) {
          return { type: "panel", panel: storedPanel };
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${msg} ${legacyPanelRecoveryHint(dbPanel.topic)}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(
        `!! Warning: panel "${safeTarget}" exists in database but failed to load its template: ${msg}\n`,
      );
      throw new CliUserError(`Failed to load panel template for "${safeTarget}"`);
    }
  } else {
    // No panel in the DB, try loading from YAML files (user panels or built-in templates).
    try {
      const panel = await loadPanel(target, dataHome);
      return { type: "panel", panel };
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
}

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
    // Validate target BEFORE TTY check to ensure error messages reach stderr
    const resolved = await validateAndResolveTarget(target, dataHome, db, writeError);

    // Now check TTY requirement (after we know the target is valid)
    if (!deps.inputProvider && !isInteractiveTerminal(process.stdin.isTTY)) {
      throw new CliUserError(
        "council chat requires an interactive terminal. Use `council ask` for non-interactive queries.",
      );
    }

    const library = new FileExpertLibrary(dataHome, db);

    if (resolved.type === "expert" && resolved.expert) {
      const expert = resolved.expert;
      // Check for file vs cached, emit warning if needed
      const fileExpert = await library.get(target);
      if (!fileExpert) {
        write(
          `\u26A0 Expert file "${target}.yaml" not found. Using cached definition from database.\n`,
        );
      }

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

    if (resolved.type === "panel" && resolved.panel) {
      await runPanelChat({
        target,
        panel: resolved.panel,
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
      return;
    }

    // Should never reach here due to validation function
    throw new CliUserError(`"${target}" not found`);
  } finally {
    await db.destroy().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
    });
  }
}

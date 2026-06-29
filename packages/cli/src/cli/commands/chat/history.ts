/**
 * `council chat --history` handler — shows archived conversations for a target.
 */
import * as path from "node:path";

import {
  withChatRepository,
  formatDate,
  writeTable,
  CliUserError,
  FileExpertLibrary,
  PanelNotFoundError,
  loadPanel,
  suggestMatch,
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  createDatabase,
  type Writer,
} from "./shared.js";
import { stripControlChars } from "../../strip-control-chars.js";
import type { ChatRepository } from "../../../memory/repositories/chat-repository.js";
import type { ChatSession } from "../../../core/chat/chat-session.js";

/** Maximum characters shown for a derived topic excerpt in `--history`. */
const TOPIC_MAX_LENGTH = 60;

/**
 * Derive a short, scannable topic summary for a session from EXISTING data
 * only (no schema change): prefer the stored rolling `summary`, otherwise fall
 * back to an excerpt of the session's first user prompt. Both sources are
 * untrusted (LLM-generated summary / user-supplied or imported prompt), so the
 * text is stripped of control/escape sequences before whitespace is collapsed
 * and the result is truncated with an ellipsis when long.
 */
async function deriveTopic(repo: ChatRepository, session: ChatSession): Promise<string> {
  const stored = session.summary?.trim();
  let source = stored && stored.length > 0 ? stored : "";
  if (source.length === 0) {
    const [firstTurn] = await repo.getTurns(session.id, { limit: 1 });
    source = firstTurn?.content.trim() ?? "";
  }
  const collapsed = stripControlChars(source).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "(no messages yet)";
  }
  return collapsed.length > TOPIC_MAX_LENGTH
    ? `${collapsed.slice(0, TOPIC_MAX_LENGTH - 1)}…`
    : collapsed;
}

export async function runHistory(target: string, write: Writer, writeError: Writer): Promise<void> {
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);
  let resolvedType: "expert" | "panel";
  try {
    const library = new FileExpertLibrary(dataHome, db);
    const expert = await library.get(target);
    if (expert) {
      resolvedType = "expert";
    } else {
      try {
        await loadPanel(target, dataHome);
        resolvedType = "panel";
      } catch (err: unknown) {
        if (err instanceof PanelNotFoundError) {
          const available = (await library.list()).map((e) => e.slug);
          const suggestions = suggestMatch(target, available);
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
          const list =
            available.length > 0
              ? available.join(", ")
              : "(none — create one with `council expert create`)";
          writeError(
            `"${target}" not found as expert or panel.${hint} Available experts: ${list}\n`,
          );
          throw new CliUserError(`"${target}" not found`);
        }
        throw err;
      }
    }
  } finally {
    await db.destroy();
  }

  await withChatRepository(async (repo) => {
    const active = await repo.findActiveSession(resolvedType, target);
    const all = await repo.listSessions({ targetSlug: target, status: "archived" });
    const archived = all.filter((s) => s.targetType === resolvedType);

    if (!active && archived.length === 0) {
      write(`No conversations for "${target}".\n`);
      return;
    }

    const header = [
      "",
      "session id",
      "messages",
      "started",
      "last active",
      "status",
      "topic",
    ] as const;

    const buildRow = async (s: ChatSession, marker: string): Promise<readonly string[]> => {
      try {
        const count = await repo.getTurnCount(s.id);
        const topic = await deriveTopic(repo, s);
        return [
          marker,
          s.id,
          String(count),
          formatDate(s.createdAt),
          formatDate(s.updatedAt),
          s.status,
          topic,
        ] as const;
      } catch {
        return [
          marker,
          s.id,
          "?",
          formatDate(s.createdAt),
          formatDate(s.updatedAt),
          s.status,
          "(unavailable)",
        ] as const;
      }
    };

    const rows: (readonly string[])[] = [];
    if (active) {
      rows.push(await buildRow(active, "→"));
    }
    for (const s of archived) {
      rows.push(await buildRow(s, ""));
    }

    if (active) {
      write('"→" marks the active conversation (resumed by `council chat ' + target + "`).\n");
    }
    writeTable(header, rows, write);
  });
}

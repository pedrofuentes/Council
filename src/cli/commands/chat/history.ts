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
    const all = await repo.listSessions({ targetSlug: target, status: "archived" });
    const archived = all.filter((s) => s.targetType === resolvedType);
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

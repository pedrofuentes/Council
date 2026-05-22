/**
 * `council chat --list` handler — lists all chat conversations.
 */
import { withChatRepository, formatDate, writeTable, type Writer } from "./shared.js";

export async function runList(write: Writer): Promise<void> {
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

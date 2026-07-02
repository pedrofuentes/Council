/**
 * Tests for `council chat` CLI command (Roadmap 5.2 — 1:1 expert chat).
 *
 * Non-interactive paths and the pure prompt-construction helper are
 * exercised here. The interactive `readline` loop is verified via an
 * injected `ChatInputProvider`; raw terminal input is NOT covered (manual
 * testing only, per task spec).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildChatCommand,
  buildChatTurnPrompt,
  type ChatInputProvider,
} from "../../../../src/cli/commands/chat.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type { ChatTurn } from "../../../../src/core/chat/chat-session.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ChatRepository } from "../../../../src/memory/repositories/chat-repository.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

const SAMPLE: ExpertDefinition = {
  slug: "dahlia-cto",
  displayName: "Dahlia Renner (CTO)",
  role: "Skeptical CTO with 20 years of experience",
  expertise: {
    weightedEvidence: ["production incident data"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Bayesian skeptic",
  kind: "generic",
};

async function seedExpert(env: TestEnv, def: ExpertDefinition = SAMPLE): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function withRepo<T>(env: TestEnv, fn: (repo: ChatRepository) => Promise<T>): Promise<T> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    return await fn(new ChatRepository(db));
  } finally {
    await db.destroy();
  }
}

function scriptedInput(lines: readonly string[]): ChatInputProvider {
  let i = 0;
  return {
    async readLine(): Promise<string | null> {
      if (i >= lines.length) return null;
      const line = lines[i] ?? null;
      i += 1;
      return line;
    },
    close(): void {
      /* no-op */
    },
  };
}

describe("buildChatCommand", () => {
  it("registers a 'chat' command", () => {
    const cmd = buildChatCommand();
    expect(cmd.name()).toBe("chat");
  });

  describe("buildChatTurnPrompt (pure)", () => {
    it("returns just the user message when there is no history", () => {
      const out = buildChatTurnPrompt({
        history: [],
        userMessage: "What's our biggest risk?",
        expertDisplayName: "Dahlia Renner (CTO)",
      });
      expect(out).toBe("What's our biggest risk?");
    });

    it("formats prior turns with role labels and appends the new user message", () => {
      const history: readonly ChatTurn[] = [
        {
          id: "t1",
          chatId: "c1",
          seq: 1,
          role: "user",
          expertSlug: null,
          content: "Hi",
          isMention: false,
          tokensIn: null,
          tokensOut: null,
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "t2",
          chatId: "c1",
          seq: 2,
          role: "expert",
          expertSlug: "dahlia-cto",
          content: "Hello there.",
          isMention: false,
          tokensIn: null,
          tokensOut: null,
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const out = buildChatTurnPrompt({
        history,
        userMessage: "Tell me more",
        expertDisplayName: "Dahlia Renner (CTO)",
      });
      expect(out).toContain("PRIOR CONVERSATION");
      expect(out).toContain("User: Hi");
      expect(out).toContain("Dahlia Renner (CTO): Hello there.");
      expect(out).toContain("Tell me more");
      // The new user message must come after the history block.
      expect(out.indexOf("Hello there.")).toBeLessThan(out.indexOf("Tell me more"));
    });
  });

  describe("--list", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("prints empty-state hint when no chat sessions exist", async () => {
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "--list"]);
      expect(out.toLowerCase()).toMatch(/no (chat )?conversations/);
    });

    it("lists active and archived sessions in a table with their statuses", async () => {
      await seedExpert(env);
      let activeId = "";
      let archivedId = "";
      await withRepo(env, async (repo) => {
        // Create the to-be-archived session first, archive it, then create the
        // active one. Doing it in this order preserves the single-active-per-
        // target invariant (#333) at every step.
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = b.id;
        await repo.archiveSession(b.id);
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        activeId = a.id;
        await repo.addTurn({ chatId: a.id, role: "user", content: "hi" });
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "--list"]);
      // Both target slug and BOTH status values (as standalone column values,
      // not just substrings of the "last active" header) must appear.
      expect(out).toContain("dahlia-cto");
      // Count "active" occurrences: the header text "last active" contributes
      // one, the active-session status column contributes another. Without
      // the active session, we'd get exactly 1 (header only).
      const activeCount = (out.match(/active/g) ?? []).length;
      expect(activeCount).toBeGreaterThanOrEqual(2);
      expect(out).toMatch(/\barchived\b/);
      // Two rows for the same target must be present.
      const slugCount = (out.match(/dahlia-cto/g) ?? []).length;
      expect(slugCount).toBe(2);
      void activeId;
      void archivedId;
    });
  });

  describe("--history", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("requires a target", async () => {
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
      });
      await expect(cmd.parseAsync(["node", "council-chat", "--history"])).rejects.toThrow(
        /target|expert/i,
      );
    });

    it("describes --history as covering active and archived conversations (#1110)", () => {
      // `--history` lists the ACTIVE session (marked "→") in addition to the
      // archived ones (see runHistory), so its help text must not advertise
      // "archived" only.
      const cmd = buildChatCommand();
      const historyOption = cmd.options.find((o) => o.long === "--history");
      expect(historyOption).toBeDefined();
      expect(historyOption?.description).toMatch(/active/i);
      expect(historyOption?.description).toMatch(/archived/i);
    });

    it("lists archived sessions for the target, excluding foreign-target rows", async () => {
      await seedExpert(env);
      await seedExpert(env, {
        ...SAMPLE,
        slug: "other-expert",
        displayName: "Other Expert",
      });
      let archivedId = "";
      let foreignArchivedId = "";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = a.id;
        await repo.archiveSession(a.id);
        const c = await repo.createSession({ targetType: "expert", targetSlug: "other-expert" });
        foreignArchivedId = c.id;
        await repo.archiveSession(c.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      // Target archived session present.
      expect(out).toContain(archivedId);
      // Foreign-target archived session absent.
      expect(out).not.toContain(foreignArchivedId);
    });

    it("indicates the active session distinctly (F23)", async () => {
      await seedExpert(env);
      let archivedId = "";
      let activeId = "";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = a.id;
        await repo.archiveSession(a.id);
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        activeId = b.id;
        await repo.addTurn({ chatId: b.id, role: "user", content: "let us discuss the roadmap" });
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      // The active session must be shown and clearly marked as active.
      expect(out).toContain(activeId);
      expect(out.toLowerCase()).toMatch(/active/);
      // Archived session still listed (no regression).
      expect(out).toContain(archivedId);
    });

    it("shows a per-session topic summary derived from existing data (F23)", async () => {
      await seedExpert(env);
      const firstPrompt = "How should we approach the database migration strategy";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: a.id, role: "user", content: firstPrompt });
        await repo.archiveSession(a.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      // A scannable topic excerpt (not just id + timestamp) must appear.
      expect(out).toContain("database migration strategy");
    });

    it("prefers a stored session summary for the topic when present (F23)", async () => {
      await seedExpert(env);
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: a.id, role: "user", content: "raw first prompt text" });
        await repo.updateSummary(a.id, "Hiring plan for Q3 engineering", 1);
        await repo.archiveSession(a.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      expect(out).toContain("Hiring plan for Q3 engineering");
    });

    it("strips control/escape sequences from the topic before writing to stdout (F23 security)", async () => {
      await seedExpert(env);
      // Untrusted stored content (LLM summary or imported first-turn) may embed
      // ANSI/OSC escapes — e.g. OSC 52 clipboard hijack and a CSI colour code.
      const malicious = "\u001b]52;c;ZXZpbA==\u0007\u001b[31mclipboard hijack\u001b[0m";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: a.id, role: "user", content: malicious });
        await repo.archiveSession(a.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      // No raw ESC / OSC / CSI / BEL escape introducers reach the terminal.
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("\u0007");
      // Visible text survives sanitization.
      expect(out).toContain("clipboard hijack");
    });

    it("strips control/escape sequences from a stored summary topic (F23 security)", async () => {
      await seedExpert(env);
      const malicious = "\u001b[2J\u001b]8;;https://evil.example\u0007Roadmap planning";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: a.id, role: "user", content: "raw first prompt text" });
        await repo.updateSummary(a.id, malicious, 1);
        await repo.archiveSession(a.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("\u0007");
      expect(out).toContain("Roadmap planning");
    });

    it("isolates per-session DB errors so one bad session doesn't blank the view (#1108)", async () => {
      await seedExpert(env);
      let goodId = "";
      let badId = "";
      await withRepo(env, async (repo) => {
        const good = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        goodId = good.id;
        await repo.addTurn({ chatId: good.id, role: "user", content: "healthy conversation" });
        await repo.archiveSession(good.id);
        const bad = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        badId = bad.id;
        await repo.archiveSession(bad.id);
      });
      const realGetTurnCount = ChatRepository.prototype.getTurnCount;
      const spy = vi
        .spyOn(ChatRepository.prototype, "getTurnCount")
        .mockImplementation(async function (this: ChatRepository, chatId: string) {
          if (chatId === badId) throw new Error("simulated getTurnCount failure");
          return realGetTurnCount.call(this, chatId);
        });
      try {
        let out = "";
        const cmd = buildChatCommand({ write: (s) => (out += s) });
        await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
        // Healthy session still renders despite the sibling failure.
        expect(out).toContain(goodId);
        // Failing session is shown with a placeholder, not dropped entirely.
        expect(out).toContain(badId);
        expect(out).toContain("(unavailable)");
      } finally {
        spy.mockRestore();
      }
    });

    it("truncates a topic longer than 60 characters with a trailing ellipsis, leaving a boundary-length topic intact (#1109)", async () => {
      await seedExpert(env);
      // Realistic, non-repeating text: a homogeneous run (e.g. "A".repeat(n))
      // would let an off-by-one-shifted slice masquerade as the correct one
      // (the shifted substring would still `toContain`-match), silently
      // defeating this assertion. Natural prose has no such run, so any
      // shift by one character changes the string and is caught.
      const base =
        "We must finalize the production database migration rollback plan before the freeze on Friday, no exceptions";
      const longTopic = base.slice(0, 75);
      // The boundary fixture must reach deriveTopic as a TRUE 60-char string
      // *after* its trim + `\s+`→" " collapse (history.ts:44). The prior
      // `base.slice(0, 60)` ended in a space, so the SUT collapsed it to 59
      // chars and never exercised the `=== 60` boundary — the assertion only
      // passed because writeTable pads the topic cell back out to width 60.
      // This standalone sentence has no leading/trailing whitespace and no
      // internal whitespace runs (so it survives collapse unchanged at exactly
      // 60 chars) and a 59-char prefix distinct from longTopic's, so their
      // truncated forms cannot alias. `overTopic` is a 61-char sibling that
      // pins the truncating side of the comparison.
      const boundaryTopic = "Confirm the incident response runbook covers the paging flow";
      const overTopic = "Escalate the cache eviction regression to on-call SRE tonight";
      // Guard the fixtures against silent drift: they must reach the length
      // check post-collapse as exactly 60 and 61 characters respectively.
      const collapse = (s: string): string => s.trim().replace(/\s+/g, " ").trim();
      expect(collapse(boundaryTopic).length).toBe(60);
      expect(collapse(overTopic).length).toBe(61);
      await withRepo(env, async (repo) => {
        const long = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: long.id, role: "user", content: "seed turn" });
        await repo.updateSummary(long.id, longTopic, 1);
        await repo.archiveSession(long.id);
        const boundary = await repo.createSession({
          targetType: "expert",
          targetSlug: "dahlia-cto",
        });
        await repo.addTurn({ chatId: boundary.id, role: "user", content: "seed turn" });
        await repo.updateSummary(boundary.id, boundaryTopic, 1);
        await repo.archiveSession(boundary.id);
        const over = await repo.createSession({
          targetType: "expert",
          targetSlug: "dahlia-cto",
        });
        await repo.addTurn({ chatId: over.id, role: "user", content: "seed turn" });
        await repo.updateSummary(over.id, overTopic, 1);
        await repo.archiveSession(over.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);

      // >60-char topic: sliced to exactly TOPIC_MAX_LENGTH - 1 (59) source
      // characters plus a trailing ellipsis. An off-by-one in the slice
      // bound would shift this by a character and fail the exact match.
      const expectedTruncated = `${longTopic.slice(0, 59)}…`;
      expect(expectedTruncated.length).toBe(60);
      expect(out).toContain(expectedTruncated);
      expect(out).not.toContain(longTopic);
      // Directly pin against an off-by-one that keeps one extra source
      // character (a 60-char slice instead of 59) before the ellipsis.
      expect(out).not.toContain(`${longTopic.slice(0, 60)}…`);

      // Exactly-60-char topic (post-collapse) is the boundary: `60 > 60` is
      // false, so it MUST render in full. Assert both that the full 60-char
      // topic appears AND that it is NOT rendered as the truncated form
      // `slice(0, 59) + "…"`. A `>`→`>=` off-by-one would truncate this exact
      // topic — its non-space 60th char replaced by the ellipsis, which
      // writeTable padding cannot reconstruct — flipping BOTH assertions. So
      // this genuinely discriminates the boundary instead of relying on the
      // padded cell width.
      const truncatedBoundary = `${boundaryTopic.slice(0, 59)}…`;
      expect(out).toContain(boundaryTopic);
      expect(out).not.toContain(truncatedBoundary);

      // 61-char topic (post-collapse) sits just over the boundary: `61 > 60`
      // is true, so it MUST be truncated to `slice(0, 59) + "…"` and its full
      // form must not appear — pinning the truncating side of the comparison.
      const truncatedOver = `${overTopic.slice(0, 59)}…`;
      expect(truncatedOver.length).toBe(60);
      expect(out).toContain(truncatedOver);
      expect(out).not.toContain(overTopic);
    });

    it("renders the literal '(no messages yet)' fallback topic for a session with no messages (#1109)", async () => {
      await seedExpert(env);
      let archivedId = "";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = a.id;
        // No turn added and no summary set: deriveTopic must fall back to
        // the literal placeholder rather than an empty/blank topic cell.
        await repo.archiveSession(a.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      expect(out).toContain(archivedId);
      expect(out).toContain("(no messages yet)");
    });

    it("places the '→' marker on the active session row, not on archived rows (#1109)", async () => {
      await seedExpert(env);
      let archivedId = "";
      let activeId = "";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = a.id;
        await repo.addTurn({ chatId: a.id, role: "user", content: "archived session turn" });
        await repo.archiveSession(a.id);
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        activeId = b.id;
        await repo.addTurn({ chatId: b.id, role: "user", content: "active session turn" });
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);

      const lines = out.split("\n");
      // The row containing the active session ID must begin with "→". Dropping
      // the marker from history.ts (buildRow active marker) causes this to fail,
      // making it discriminating — unlike toMatch(/active/) which matches the
      // always-present legend line and status column.
      const activeRow = lines.find((l) => l.includes(activeId));
      expect(activeRow).toBeDefined();
      expect(activeRow).toMatch(/^→/);

      // Archived session row must NOT carry the marker — rules out a scenario
      // where "→" is written on every row.
      const archivedRow = lines.find((l) => l.includes(archivedId));
      expect(archivedRow).toBeDefined();
      expect(archivedRow).not.toMatch(/^→/);
    });
  });

  describe("expert resolution", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("resolves engine from config when --engine is omitted", async () => {
      await seedExpert(env);
      // With engine default feature, omitting --engine no longer throws —
      // it resolves from config (default: "copilot"). The test verifies it
      // does NOT throw the old "--engine is required" error.
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
      });
      // It will attempt to start an engine and likely fail with a different
      // error (e.g. model not available in test env), but NOT the old
      // "--engine is required" error.
      let thrown = "";
      try {
        await cmd.parseAsync(["node", "council-chat", "dahlia-cto"]);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).not.toMatch(/--engine is required/i);
    });

    it("errors when --engine value is unknown", async () => {
      await seedExpert(env);
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
      });
      cmd.exitOverride();
      await expect(
        cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "bogus"]),
      ).rejects.toThrow(/engine.*allowed choices|allowed choices.*engine/i);
    });

    it("errors when the expert slug does not exist", async () => {
      let err = "";
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: (s) => (err += s),
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput([]),
      });
      await expect(
        cmd.parseAsync(["node", "council-chat", "ghost", "--engine", "mock"]),
      ).rejects.toThrow(/not found/i);
      expect(err).toMatch(/not found/i);
      expect(err).toMatch(/dahlia-cto|Available experts/i);
    });

    it("throws CliUserError (not plain Error) for not-found target", async () => {
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput([]),
      });
      try {
        await cmd.parseAsync(["node", "council-chat", "ghost", "--engine", "mock"]);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliUserError);
      }
    });
  });

  describe("session lifecycle", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("creates a new session, persists user + expert turns, and exits on /quit", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["hello there", "/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(out).toMatch(/Starting 1:1 chat/i);
      expect(out).toMatch(/Conversation saved/i);

      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        expect(session).toBeDefined();
        const turns = await repo.getTurns(session?.id ?? "");
        expect(turns.length).toBe(2);
        expect(turns[0]?.role).toBe("user");
        expect(turns[0]?.content).toBe("hello there");
        expect(turns[1]?.role).toBe("expert");
        expect(turns[1]?.expertSlug).toBe("dahlia-cto");
        expect(turns[1]?.content.length).toBeGreaterThan(0);
      });
    });

    it("resumes an active session and shows resume banner", async () => {
      await seedExpert(env);
      await withRepo(env, async (repo) => {
        const s = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: s.id, role: "user", content: "earlier" });
        await repo.addTurn({
          chatId: s.id,
          role: "expert",
          expertSlug: "dahlia-cto",
          content: "earlier reply",
        });
      });

      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);
      expect(out).toMatch(/Resuming conversation/i);
      expect(out).toMatch(/2 messages/i);
    });

    it("--new archives the existing active session and starts fresh", async () => {
      await seedExpert(env);
      let priorId = "";
      await withRepo(env, async (repo) => {
        const s = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        priorId = s.id;
        await repo.addTurn({ chatId: s.id, role: "user", content: "old" });
      });

      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock", "--new"]);

      expect(out).toMatch(/archived/i);

      await withRepo(env, async (repo) => {
        const prior = await repo.findSessionById(priorId);
        expect(prior?.status).toBe("archived");
        const active = await repo.findActiveSession("expert", "dahlia-cto");
        expect(active).toBeDefined();
        expect(active?.id).not.toBe(priorId);
      });
    });

    it("--new does NOT archive the prior session when engine startup fails", async () => {
      await seedExpert(env);
      let priorId = "";
      await withRepo(env, async (repo) => {
        const s = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        priorId = s.id;
        await repo.addTurn({ chatId: s.id, role: "user", content: "old" });
      });

      // Engine that fails on addExpert immediately.
      const failing = new MockEngine({ failOnAddExpert: { afterN: 0 } });
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
        engineFactory: () => failing,
        inputProvider: () => scriptedInput([]),
      });
      await expect(
        cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock", "--new"]),
      ).rejects.toThrow();

      await withRepo(env, async (repo) => {
        const prior = await repo.findSessionById(priorId);
        // Atomicity: prior session must remain ACTIVE since startup failed.
        expect(prior?.status).toBe("active");
      });
    });

    it("exits gracefully on EOF (input provider returns null)", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput([]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);
      expect(out).toMatch(/Conversation saved/i);
    });

    it("injects [PANEL MEMBERSHIPS] into the 1:1 chat system prompt when the expert belongs to a panel (issue #404)", async () => {
      // Issue #404: cross-panel awareness is observable in `council chat
      // <expert>` 1:1 mode only via the system prompt — but no test
      // verified that. Seed a panel containing the expert, capture the
      // ExpertSpec passed to `engine.addExpert`, and assert the system
      // prompt carries the membership block.
      await seedExpert(env);
      // Seed a second expert as co-member so the rendered block carries
      // a visible "(with …)" clause that proves the join walked
      // expert_library too.
      await seedExpert(env, {
        slug: "marcus-arch",
        displayName: "Marcus Chen (Architect)",
        role: "Systems architect",
        expertise: {
          weightedEvidence: ["postmortems"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "Engineering rigor",
        kind: "generic",
      });

      // Register the panel directly via the repository (no template
      // migration runs during `council chat`).
      const { PanelLibraryRepository } =
        await import("../../../../src/memory/repositories/panel-library-repo.js");
      const seedingDb = await createDatabase(path.join(env.home, "council.db"));
      try {
        const repo = new PanelLibraryRepository(seedingDb);
        await repo.create({
          name: "architecture-review",
          description: "Cross-functional architecture deliberation",
          yamlPath: path.join(env.dataHome, "panels", "architecture-review.yaml"),
          yamlChecksum: "ch1",
        });
        await repo.setMembers("architecture-review", ["dahlia-cto", "marcus-arch"]);
      } finally {
        await seedingDb.destroy();
      }

      // Capture the systemMessage handed to addExpert via a wrapping
      // engine factory (same pattern as resume.test.ts).
      const capturedSystemMessages: string[] = [];
      const capturingFactory = (): CouncilEngine => {
        const real = new MockEngine();
        return {
          start: () => real.start(),
          stop: () => real.stop(),
          addExpert: (spec) => {
            capturedSystemMessages.push(spec.systemMessage);
            return real.addExpert(spec);
          },
          removeExpert: (id) => real.removeExpert(id),
          send: (opts) => real.send(opts),
          listModels: () => real.listModels(),
        };
      };

      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
        engineFactory: capturingFactory,
        inputProvider: () => scriptedInput(["hi", "/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(capturedSystemMessages.length).toBeGreaterThanOrEqual(1);
      const sys = capturedSystemMessages[0] ?? "";
      expect(sys).toContain("PANEL MEMBERSHIPS");
      // Panel name and co-member must be rendered into the block.
      expect(sys).toMatch(/architecture-review/i);
      expect(sys).toContain("Marcus Chen (Architect)");
      // The expert themselves must NOT appear as a co-member.
      expect(sys).not.toMatch(/with[^)]*Dahlia Renner/);
    });

    it("surfaces a warning (not silence) when the panel-membership query fails, and still starts chat", async () => {
      // Force the membership query to throw by dropping the panel_members
      // table from the underlying DB after the schema migration. The chat
      // command opens its own DB connection but reads the same file, so
      // the dropped table will surface as a SQLite "no such table" error
      // at query time. The chat must still launch (best-effort context).
      await seedExpert(env);
      const setupDb = await createDatabase(path.join(env.home, "council.db"));
      try {
        await setupDb.schema.dropTable("panel_members").execute();
      } finally {
        await setupDb.destroy();
      }

      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["hi", "/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      // Warning must be surfaced — a silent swallow would leave operators
      // unable to diagnose why cross-panel context never appears.
      expect(out).toMatch(/panel memberships|cross-panel/i);
      // Chat must still complete: user turn is persisted.
      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        expect(session).toBeDefined();
        const turns = await repo.getTurns(session?.id ?? "");
        expect(turns.some((t) => t.role === "user" && t.content === "hi")).toBe(true);
      });
    });

    it("on engine error: saves the user turn, warns, and continues the loop", async () => {
      await seedExpert(env);

      // Custom engine: succeeds add/start/stop but every send() yields
      // a non-recoverable error event.
      const failingEngine: CouncilEngine = {
        async start(): Promise<void> {
          /* ok */
        },
        async stop(): Promise<void> {
          /* ok */
        },
        async addExpert(): Promise<void> {
          /* ok */
        },
        async removeExpert(): Promise<void> {
          /* ok */
        },
        async listModels(): Promise<readonly string[]> {
          return ["mock"];
        },
        send(opts) {
          const expertId = opts.expertId;
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                kind: "error" as const,
                expertId,
                error: { code: "PROVIDER_ERROR" as const, message: "boom" },
                recoverable: false,
              };
            },
          };
        },
      };

      let out = "";
      let err = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: (s) => (err += s),
        engineFactory: () => failingEngine,
        inputProvider: () => scriptedInput(["help me", "exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      // User turn must be persisted even when the response failed (PRD §F4).
      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        const turns = await repo.getTurns(session?.id ?? "");
        expect(turns.some((t) => t.role === "user" && t.content === "help me")).toBe(true);
        // No expert turn was saved (the response failed).
        expect(turns.some((t) => t.role === "expert")).toBe(false);
      });
      // The loop continued past the failure to the second scripted line.
      expect(out).toMatch(/Conversation saved/i);
      // A user-facing warning was emitted somewhere.
      expect(out + err).toMatch(/Failed to get response/i);
    });

    it("on recoverable engine error: retries once and persists a single clean expert turn", async () => {
      await seedExpert(env);
      let out = "";

      // Engine fails recoverably on the first send() and succeeds on the
      // second. Counts send calls; the first attempt yields a partial
      // delta then a recoverable error, the retry yields a complete
      // response. The chat command must (a) call send() exactly twice,
      // (b) persist exactly one expert turn with the retry's content
      // only — NOT the concatenation of partial + retry.
      let sendCalls = 0;
      const retryingEngine: CouncilEngine = {
        async start(): Promise<void> {
          /* ok */
        },
        async stop(): Promise<void> {
          /* ok */
        },
        async addExpert(): Promise<void> {
          /* ok */
        },
        async removeExpert(): Promise<void> {
          /* ok */
        },
        async listModels(): Promise<readonly string[]> {
          return ["mock"];
        },
        send(opts) {
          const expertId = opts.expertId;
          sendCalls += 1;
          const isFirst = sendCalls === 1;
          return {
            async *[Symbol.asyncIterator]() {
              if (isFirst) {
                yield { kind: "message.delta" as const, expertId, text: "PARTIAL-" };
                yield {
                  kind: "error" as const,
                  expertId,
                  error: { code: "NETWORK" as const, message: "transient" },
                  recoverable: true,
                };
              } else {
                yield { kind: "message.delta" as const, expertId, text: "FINAL-OK" };
                yield {
                  kind: "message.complete" as const,
                  expertId,
                  response: { latencyMs: 1 },
                };
              }
            },
          };
        },
      };

      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => retryingEngine,
        inputProvider: () => scriptedInput(["question?", "exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(sendCalls).toBe(2);
      // The partial first-attempt delta must NOT be rendered to stdout —
      // doing so would double-render the response on retry.
      expect(out).not.toContain("PARTIAL-");
      expect(out).toContain("FINAL-OK");
      const finalCount = (out.match(/FINAL-OK/g) ?? []).length;
      expect(finalCount).toBe(1);
      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        const turns = await repo.getTurns(session?.id ?? "");
        const expertTurns = turns.filter((t) => t.role === "expert");
        expect(expertTurns.length).toBe(1);
        // The persisted expert turn must contain ONLY the retry's
        // content — the partial first attempt must not leak into it.
        expect(expertTurns[0]?.content).toBe("FINAL-OK");
        expect(expertTurns[0]?.content).not.toContain("PARTIAL");
      });
    });
  });
});

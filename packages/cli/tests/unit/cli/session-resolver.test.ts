import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyTemplateDb } from "../../helpers/template-db.js";
import { CliUserError } from "../../../src/cli/cli-user-error.js";
import { resolveSession } from "../../../src/cli/session-resolver.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";

describe("resolveSession", () => {
  let testHome: string;
  let db: CouncilDatabase;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-session-resolver-"));
    await copyTemplateDb(path.join(testHome, "council.db"));
    db = await createDatabase(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    await db.destroy();
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  async function seedPanel(name: string, topic = `Topic for ${name}`): Promise<void> {
    await new PanelRepository(db).create({
      name,
      topic,
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
  }

  it("prefers an exact match over longer names that share the same prefix", async () => {
    await seedPanel("code-review");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedPanel("code-review-extended");

    const resolved = await resolveSession({
      db,
      dataHome: testHome,
      panelArg: "code-review",
      writeError: () => undefined,
      isNonInteractive: () => true,
    });

    expect(resolved).toBe("code-review");
  });

  it("auto-selects a unique prefix match", async () => {
    await seedPanel("architecture-review-2025");

    const resolved = await resolveSession({
      db,
      dataHome: testHome,
      panelArg: "architecture",
      writeError: () => undefined,
      isNonInteractive: () => true,
    });

    expect(resolved).toBe("architecture-review-2025");
  });

  it("uses the interactive picker when multiple sessions share a prefix", async () => {
    await seedPanel("code-review-a", "Alpha topic");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedPanel("code-review-b", "Beta topic");

    let seenNames: readonly string[] = [];
    let seenTopics: readonly (string | null)[] = [];
    let seenTimestamps: readonly string[] = [];
    const resolved = await resolveSession({
      db,
      dataHome: testHome,
      panelArg: "code-review",
      writeError: () => undefined,
      isNonInteractive: () => false,
      picker: async (matches) => {
        seenNames = matches.map((match) => match.name);
        seenTopics = matches.map((match) => match.topic);
        seenTimestamps = matches.map((match) => match.createdAt);
        const selected = matches.find((match) => match.name === "code-review-a");
        if (selected) return selected;
        throw new Error("Expected code-review-a to be present in picker matches.");
      },
    });

    expect(resolved).toBe("code-review-a");
    expect(seenNames).toContain("code-review-a");
    expect(seenNames).toContain("code-review-b");
    expect(seenTopics).toContain("Alpha topic");
    expect(seenTopics).toContain("Beta topic");
    expect(seenTimestamps.every((value) => value.length > 0)).toBe(true);
  });

  it("prints a numbered fallback list in non-interactive mode when a prefix is ambiguous", async () => {
    await seedPanel("code-review-a", "Alpha topic");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedPanel("code-review-b", "Beta topic");

    let stderr = "";
    await expect(
      resolveSession({
        db,
        dataHome: testHome,
        panelArg: "code-review",
        writeError: (chunk) => {
          stderr += chunk;
        },
        isNonInteractive: () => true,
      }),
    ).rejects.toBeInstanceOf(CliUserError);

    expect(stderr).toContain('Multiple panels match "code-review"');
    expect(stderr).toMatch(/1\. code-review-/);
    expect(stderr).toContain("Alpha topic");
    expect(stderr).toContain("Beta topic");
  });

  it("F18: ambiguous prefix includes disambiguation guidance to use the full name", async () => {
    await seedPanel("code-review-a", "Alpha topic");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedPanel("code-review-b", "Beta topic");

    let stderr = "";
    await expect(
      resolveSession({
        db,
        dataHome: testHome,
        panelArg: "code-review",
        writeError: (chunk) => {
          stderr += chunk;
        },
        isNonInteractive: () => true,
      }),
    ).rejects.toBeInstanceOf(CliUserError);

    // After listing the matches, tell the user how to disambiguate.
    expect(stderr).toMatch(/full name/i);
    expect(stderr).toContain("council resume");
  });

  it("explains when a panel template exists but has no debates yet", async () => {
    const panelsDir = path.join(testHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
    await fs.writeFile(
      path.join(panelsDir, "empty-panel.yaml"),
      [
        "name: empty-panel",
        "description: Empty panel template",
        "experts:",
        "  - slug: reviewer",
        "    displayName: Reviewer",
        "    role: Reviews code",
        "    expertise:",
        "      weightedEvidence:",
        "        - Reads diffs carefully",
        "      referenceCases: []",
        "      notExpertIn: []",
        "    epistemicStance: Cautious",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      resolveSession({
        db,
        dataHome: testHome,
        panelArg: "empty-panel",
        writeError: () => undefined,
        isNonInteractive: () => true,
      }),
    ).rejects.toThrow(/exists but has no debates yet/i);
  });

  it("offers did-you-mean suggestions when no panel or template matches", async () => {
    await seedPanel("finance-review");

    await expect(
      resolveSession({
        db,
        dataHome: testHome,
        panelArg: "financ-review",
        writeError: () => undefined,
        isNonInteractive: () => true,
      }),
    ).rejects.toThrow(/did you mean|finance-review/i);
  });

  // Terminal-safety: untrusted panel metadata (names/topics) and the requested
  // string must be single-line sanitized before being written to stderr, or a
  // malicious value could spoof lines / inject ANSI escapes (#779).
  describe("sanitizes untrusted values written to stderr (#779)", () => {
    const ESC = "\u001b";
    const BEL = "\u0007";
    const LINE_SEP = "\u2028";

    it("strips CR/LF/ANSI/control sequences from ambiguous-match topics", async () => {
      await seedPanel("amb-alpha", "Alpha\r\n  99. spoofed entry");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await seedPanel("amb-beta", `Beta${ESC}[31mred${ESC}[0m${BEL}${LINE_SEP}sneaky`);

      let stderr = "";
      await expect(
        resolveSession({
          db,
          dataHome: testHome,
          panelArg: "amb",
          writeError: (chunk) => {
            stderr += chunk;
          },
          isNonInteractive: () => true,
        }),
      ).rejects.toBeInstanceOf(CliUserError);

      expect(stderr).not.toContain(ESC);
      expect(stderr).not.toContain(BEL);
      expect(stderr).not.toContain("\r");
      expect(stderr).not.toContain(LINE_SEP);
      // The injected "  99. spoofed entry" must NOT become its own numbered
      // line — there are exactly two matches, so exactly two numbered entries.
      const numberedEntries = stderr.split("\n").filter((line) => /^\s*\d+\.\s/.test(line));
      expect(numberedEntries).toHaveLength(2);
    });

    it("strips ANSI escapes from ambiguous-match panel names", async () => {
      await seedPanel(`clr-${ESC}[31mred`, "topic one");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await seedPanel(`clr-${ESC}[32mgreen`, "topic two");

      let stderr = "";
      await expect(
        resolveSession({
          db,
          dataHome: testHome,
          panelArg: "clr-",
          writeError: (chunk) => {
            stderr += chunk;
          },
          isNonInteractive: () => true,
        }),
      ).rejects.toBeInstanceOf(CliUserError);

      expect(stderr).not.toContain(ESC);
      // Visible text (with escapes removed) is preserved.
      expect(stderr).toContain("clr-red");
      expect(stderr).toContain("clr-green");
    });

    it("keeps the raw (unsanitized) name in picker input and the resolved value", async () => {
      const rawName = `clr-${ESC}[31mred`;
      await seedPanel(rawName, "topic one");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await seedPanel(`clr-${ESC}[32mgreen`, "topic two");

      let sawRawName = false;
      const resolved = await resolveSession({
        db,
        dataHome: testHome,
        panelArg: "clr-",
        writeError: () => undefined,
        isNonInteractive: () => false,
        picker: async (matches) => {
          sawRawName = matches.some((match) => match.name.includes(ESC));
          const selected = matches.find((match) => match.name === rawName);
          if (selected) return selected;
          throw new Error("Expected the raw panel name to be present in picker matches.");
        },
      });

      // Sanitization is display-only: the loadable panel name must stay intact.
      expect(sawRawName).toBe(true);
      expect(resolved).toBe(rawName);
    });

    it("strips control sequences from the requested value echoed on no-match", async () => {
      await seedPanel("finance-review");

      let stderr = "";
      await expect(
        resolveSession({
          db,
          dataHome: testHome,
          panelArg: `ghost${ESC}[31m${BEL}phantom`,
          writeError: (chunk) => {
            stderr += chunk;
          },
          isNonInteractive: () => true,
        }),
      ).rejects.toBeInstanceOf(CliUserError);

      expect(stderr).not.toContain(ESC);
      expect(stderr).not.toContain(BEL);
      expect(stderr).toContain("No panel found matching 'ghostphantom'");
    });
  });

  // The most-recently-debated fallback (used by `conclude` with no panel arg)
  // must resolve the panel of the newest debate without an N+1 scan (#705).
  describe("most-recently-debated resolution (#705)", () => {
    async function seedDebate(panelName: string): Promise<void> {
      const panel = await new PanelRepository(db).findByName(panelName);
      if (!panel) throw new Error(`Expected seeded panel '${panelName}'.`);
      await new DebateRepository(db).create({
        panelId: panel.id,
        prompt: `Prompt for ${panelName}`,
        moderator: "round-robin",
      });
    }

    it("selects the panel with the newest debate, not the newest panel", async () => {
      await seedPanel("panel-a");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await seedPanel("panel-b");

      // panel-b is newer by creation, but panel-a gets the more recent debate.
      await seedDebate("panel-b");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await seedDebate("panel-a");

      const resolved = await resolveSession({
        db,
        dataHome: testHome,
        writeError: () => undefined,
        isNonInteractive: () => true,
        missingPanelMode: "most-recently-debated",
      });

      expect(resolved).toBe("panel-a");
    });

    it("errors when panels exist but none have any debates", async () => {
      await seedPanel("no-debates-here");

      await expect(
        resolveSession({
          db,
          dataHome: testHome,
          writeError: () => undefined,
          isNonInteractive: () => true,
          missingPanelMode: "most-recently-debated",
        }),
      ).rejects.toThrow(/no panels with debates/i);
    });
  });
});

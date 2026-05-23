import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliUserError } from "../../../src/cli/cli-user-error.js";
import { resolveSession } from "../../../src/cli/session-resolver.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";

describe("resolveSession", () => {
  let testHome: string;
  let db: CouncilDatabase;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-session-resolver-"));
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
        return matches.find((match) => match.name === "code-review-a") ?? matches[0]!;
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
});

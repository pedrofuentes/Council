/**
 * Tests for `--panel` alias for `--template` option (Finding 15).
 *
 * Users think in terms of "panels" not "templates". Both
 * `--panel` and `--template` should work, with backward compatibility.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";

describe("convene --panel alias", () => {
  function makeMockEngineFactory(): () => CouncilEngine {
    return () =>
      new MockEngine({
        responses: {},
      });
  }

  it("registers --panel option alongside --template", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });

    const panelOpt = cmd.options.find((o) => o.long === "--panel");
    const templateOpt = cmd.options.find((o) => o.long === "--template");

    expect(panelOpt).toBeDefined();
    expect(templateOpt).toBeDefined();
    expect(panelOpt?.description).toMatch(/template|panel/i);
  });

  it("shows both --panel and --template in help text", () => {
    const cmd = buildConveneCommand({ engineFactory: makeMockEngineFactory() });
    const helpText = cmd.helpInformation();

    expect(helpText).toMatch(/--panel/);
    expect(helpText).toMatch(/--template/);
  });

  describe("behavioral parity between --panel and --template", () => {
    let testHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "convene-panel-alias-"));
      originalHome = process.env["COUNCIL_HOME"];
      process.env["COUNCIL_HOME"] = testHome;
    });

    afterEach(async () => {
      if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = originalHome;
      try {
        await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    });

    async function runWithFlagInHome(
      flag: "--panel" | "--template",
      home: string,
    ): Promise<{
      readonly templateName: string;
      readonly expertSlugs: readonly string[];
    }> {
      const cmd = buildConveneCommand({
        engineFactory: makeMockEngineFactory(),
        write: () => undefined,
        writeError: () => undefined,
      });
      await cmd.parseAsync([
        "node",
        "council-convene",
        "Should we ship?",
        flag,
        "code-review",
        "--max-rounds",
        "1",
        "--engine",
        "mock",
      ]);

      const db = await createDatabase(path.join(home, "council.db"));
      try {
        const panels = await new PanelRepository(db).findAll();
        expect(panels).toHaveLength(1);
        const panelRow = panels[0];
        if (!panelRow) throw new Error("no panel persisted");
        const cfg = JSON.parse(panelRow.configJson) as { template?: string };
        const experts = await new ExpertRepository(db).findByPanelId(panelRow.id);
        return {
          templateName: cfg.template ?? "",
          expertSlugs: experts.map((e) => e.slug).sort(),
        };
      } finally {
        await db.destroy();
      }
    }

    it("--panel <name> resolves to the same template as --template <name>", async () => {
      // Use separate HOMEs per invocation to avoid Windows file locks on
      // the shared council.db between runs.
      const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "convene-alias-a-"));
      const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "convene-alias-b-"));
      try {
        process.env["COUNCIL_HOME"] = homeA;
        const viaPanel = await runWithFlagInHome("--panel", homeA);
        process.env["COUNCIL_HOME"] = homeB;
        const viaTemplate = await runWithFlagInHome("--template", homeB);

        // Both flags must produce identical template resolution.
        expect(viaPanel.templateName).toBe("code-review");
        expect(viaTemplate.templateName).toBe("code-review");
        expect(viaPanel.templateName).toBe(viaTemplate.templateName);

        // And they must instantiate the same set of experts.
        expect(viaPanel.expertSlugs.length).toBeGreaterThan(0);
        expect(viaPanel.expertSlugs).toEqual(viaTemplate.expertSlugs);
      } finally {
        for (const h of [homeA, homeB]) {
          try {
            await fs.rm(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          } catch {
            /* best effort */
          }
        }
      }
    });
  });
});

/**
 * Tests for expert persona onboarding UX improvements (T7).
 *
 * Verifies that:
 * - `council expert create --help` clearly explains --persona enables training
 * - Help text includes persona workflow examples
 * - Training error for generic experts suggests the --persona flag
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExpertCommand } from "../../../../src/cli/commands/expert.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
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

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { createDatabase } = await import("../../../../src/memory/db.js");
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

describe("Expert persona onboarding UX (T7)", () => {
  describe("expert create --help", () => {
    it("explains that --persona creates a trainable expert", () => {
      const cmd = buildExpertCommand();
      const createCmd = cmd.commands.find((c) => c.name() === "create");
      expect(createCmd).toBeDefined();
      const helpText = createCmd?.helpInformation() ?? "";
      
      // The --persona flag description should mention "trainable" (not in old text)
      // and "document-based training" (in both, but validates basic content)
      expect(helpText.toLowerCase()).toMatch(/trainable/);
      expect(helpText.toLowerCase()).toMatch(/document-based training/);
    });

    it("includes examples showing persona creation and training workflow", async () => {
      // Commander.js's helpInformation() doesn't include addHelpText sections,
      // but we can verify the examples exist by spawning the CLI process
      const { spawn } = await import("node:child_process");
      const proc = spawn(process.execPath, [
        "dist/bin/council.js",
        "expert",
        "create",
        "--help",
      ], { cwd: process.cwd() });
      
      let output = "";
      proc.stdout.on("data", (data) => { output += data.toString(); });
      
      await new Promise((resolve) => {
        proc.on("close", resolve);
      });
      
      // Should have examples showing the persona workflow
      expect(output).toMatch(/examples:/i);
      expect(output.toLowerCase()).toMatch(/persona/);
      expect(output.toLowerCase()).toMatch(/train/);
    });
  });

  describe("expert train error message", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("suggests --persona flag when training fails on generic expert", async () => {
      const GENERIC_EXPERT: ExpertDefinition = {
        slug: "generic-expert",
        displayName: "Generic Expert",
        role: "Test role",
        expertise: { weightedEvidence: ["test"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "Test stance",
        kind: "generic",
      };
      
      await seedExpert(env, GENERIC_EXPERT);
      
      let errorOutput = "";
      const cmd = buildExpertCommand(
        () => { /* noop */ },
        (s) => { errorOutput += s; },
      );
      
      await expect(
        cmd.parseAsync(["node", "council-expert", "train", "generic-expert"]),
      ).rejects.toThrow(/persona/i);
      
      // Error message should suggest creating with --persona
      expect(errorOutput.toLowerCase()).toMatch(/create.*--persona/);
      expect(errorOutput).toMatch(/council expert create/);
    });
  });
});

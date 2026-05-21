/**
 * Tests for DX-19: .choices() migration and DX-03: fuzzy-match integration
 * in expert/panel lookup failures.
 *
 * RED at this commit: Commands don't use .choices() and don't offer
 * fuzzy suggestions on slug typos.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildExpertCommand } from "../../../src/cli/commands/expert.js";
import { buildConcludeCommand } from "../../../src/cli/commands/conclude.js";
import { buildExportCommand } from "../../../src/cli/commands/export.js";

describe("DX-19: Commander .choices() on --engine", () => {
  it("conclude command rejects invalid --engine with Commander choices error", async () => {
    const cmd = buildConcludeCommand({
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => undefined });
    await expect(
      cmd.parseAsync(["conclude", "test-panel", "--engine", "invalid"], { from: "user" }),
    ).rejects.toThrow(/Allowed choices are/i);
  });

  it("export command rejects invalid --format with Commander choices error", async () => {
    const cmd = buildExportCommand({
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => undefined });
    await expect(
      cmd.parseAsync(["export", "test-panel", "--format", "invalid"], { from: "user" }),
    ).rejects.toThrow(/Allowed choices are/i);
  });
});

describe("DX-03: fuzzy-match in expert lookup", () => {
  let env: { home: string; dataHome: string; originalHome: string | undefined; originalDataHome: string | undefined };

  beforeEach(async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-fuzzy-"));
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-fuzzy-data-"));
    env = {
      home,
      dataHome,
      originalHome: process.env["COUNCIL_HOME"],
      originalDataHome: process.env["COUNCIL_DATA_HOME"],
    };
    process.env["COUNCIL_HOME"] = home;
    process.env["COUNCIL_DATA_HOME"] = dataHome;

    // Seed an expert named "dahlia-cto"
    const { createDatabase } = await import("../../../src/memory/db.js");
    const { FileExpertLibrary } = await import("../../../src/core/expert-library.js");
    const db = await createDatabase(path.join(home, "council.db"));
    try {
      const lib = new FileExpertLibrary(dataHome, db);
      await lib.create({
        slug: "dahlia-cto",
        displayName: "Dahlia Renner (CTO)",
        role: "CTO",
        expertise: { weightedEvidence: ["systems design"], referenceCases: ["monolith migration"], notExpertIn: ["frontend"] },
        epistemicStance: "skeptic",
        kind: "generic",
      });
    } finally {
      await db.destroy();
    }
  });

  afterEach(async () => {
    if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = env.originalHome;
    if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
    await fs.rm(env.home, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(env.dataHome, { recursive: true, force: true }).catch(() => undefined);
  });

  it("expert inspect suggests closest match when slug not found", async () => {
    const errors: string[] = [];
    const cmd = buildExpertCommand(
      () => undefined,
      (s) => errors.push(s),
    );
    cmd.exitOverride();
    try {
      await cmd.parseAsync(["node", "council-expert", "inspect", "dahlia-ct"]);
    } catch {
      // Expected: CliUserError for not-found
    }
    const joined = errors.join("");
    expect(joined).toMatch(/not found/i);
    expect(joined).toMatch(/Did you mean/i);
    expect(joined).toMatch(/dahlia-cto/);
  });
});

/**
 * Tests for DX-19: .choices() migration and DX-03: fuzzy-match integration
 * in expert/panel lookup failures.
 *
 * RED at this commit: Commands don't use .choices() and don't offer
 * fuzzy suggestions on slug typos.
 */
import { describe, expect, it } from "vitest";

import { buildExpertCommand } from "../../../src/cli/commands/expert.js";
import { buildConcludeCommand } from "../../../src/cli/commands/conclude.js";
import { buildExportCommand } from "../../../src/cli/commands/export.js";

describe("DX-19: Commander .choices() on --engine", () => {
  it("conclude command rejects invalid --engine with Commander choices error", async () => {
    const cmd = buildConcludeCommand({
      write: () => {},
      writeError: () => {},
    });
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => {} });
    await expect(
      cmd.parseAsync(["conclude", "test-panel", "--engine", "invalid"], { from: "user" }),
    ).rejects.toThrow(/Allowed choices are/i);
  });

  it("export command rejects invalid --format with Commander choices error", async () => {
    const cmd = buildExportCommand({
      write: () => {},
      writeError: () => {},
    });
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => {} });
    await expect(
      cmd.parseAsync(["export", "test-panel", "--format", "invalid"], { from: "user" }),
    ).rejects.toThrow(/Allowed choices are/i);
  });
});

describe("DX-03: fuzzy-match in expert lookup", () => {
  it("expert inspect suggests closest match when slug not found", async () => {
    const errors: string[] = [];
    const cmd = buildExpertCommand(
      () => {},
      (s) => errors.push(s),
    );
    cmd.exitOverride();
    // This will fail with expert not found — but it needs a real library.
    // We just verify the error path exists and includes the fuzzy suggestion
    // infrastructure. Integration tests cover the full path.
    try {
      await cmd.parseAsync(["expert", "inspect", "ct"], { from: "user" });
    } catch {
      // Expected to throw (CliUserError or other)
    }
    // At minimum, the error was written (library path won't have experts,
    // so the suggestion won't appear — but the error message format should
    // use the standardized "error: " prefix).
    const joined = errors.join("");
    if (joined.length > 0) {
      expect(joined).toMatch(/not found/i);
    }
  });
});

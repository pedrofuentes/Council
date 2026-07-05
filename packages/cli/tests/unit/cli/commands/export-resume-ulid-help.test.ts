/**
 * Tests that export and resume command help text documents ULID lookup.
 *
 * Issue #2393: The `export` and `resume` commands accept both panel names
 * and session ULIDs (as shown by `council sessions`), but the positional
 * argument descriptions in `--help` only mention "Panel name" without
 * documenting the ULID lookup capability.
 *
 * This test verifies that both command builders include "ULID" or "id"
 * in their argument descriptions to make the feature discoverable.
 */
import { describe, expect, it } from "vitest";

import { buildExportCommand } from "../../../../src/cli/commands/export.js";
import { buildResumeCommand } from "../../../../src/cli/commands/resume.js";

describe("export command help text", () => {
  it("documents ULID lookup in the <panel> argument description", () => {
    const cmd = buildExportCommand();
    const args = cmd.registeredArguments;

    expect(args).toHaveLength(1);
    const panelArg = args[0];
    expect(panelArg?.name()).toBe("panel");

    const description = panelArg?.description ?? "";
    // The description should mention ULID or id to document the lookup capability
    expect(description.toLowerCase()).toMatch(/ulid|id/);
  });
});

describe("resume command help text", () => {
  it("documents ULID lookup in the [panel] argument description", () => {
    const cmd = buildResumeCommand();
    const args = cmd.registeredArguments;

    expect(args).toHaveLength(1);
    const panelArg = args[0];
    expect(panelArg?.name()).toBe("panel");

    const description = panelArg?.description ?? "";
    // The description should mention ULID or id to document the lookup capability
    expect(description.toLowerCase()).toMatch(/ulid|id/);
  });
});

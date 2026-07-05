/**
 * Test that export/resume --help documents ULID lookup support (GitHub issue #2393).
 *
 * The positional argument descriptions should mention that a session ULID/id
 * is accepted, not just panel name.
 */
import { describe, expect, it, vi } from "vitest";

import { buildExportCommand } from "../../../../src/cli/commands/export.js";
import { buildResumeCommand } from "../../../../src/cli/commands/resume.js";

describe("export/resume ULID help text", () => {
  it("export command argument description mentions ULID or id", () => {
    const cmd = buildExportCommand();
    const panelArg = cmd.registeredArguments?.[0];
    expect(panelArg).toBeDefined();
    expect(panelArg?.description).toMatch(/ULID|id/i);
  });

  it("resume command argument description mentions ULID or id", () => {
    const mockEngineFactory = vi.fn();
    const cmd = buildResumeCommand({ engineFactory: mockEngineFactory });
    const panelArg = cmd.registeredArguments?.[0];
    expect(panelArg).toBeDefined();
    expect(panelArg?.description).toMatch(/ULID|id/i);
  });
});

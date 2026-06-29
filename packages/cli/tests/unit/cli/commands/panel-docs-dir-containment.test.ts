/**
 * Path-containment guard for `panelDocsDir` (#1780).
 *
 * `panel docs list` and other sibling scanners build the managed docs dir
 * directly from `panel_library.name`, which may have been populated via
 * migration/import/DB edit that bypassed create-time validation. Without a
 * guard a name with traversal segments (e.g. `../../etc`) would make the
 * scanner index out-of-tree files. Mirror the `validatePanelName` +
 * `startsWith(panelsRoot + sep)` defense used by `resolveManagedDocsDir`.
 */
import { describe, expect, it } from "vitest";

import { panelDocsDir } from "../../../../src/cli/commands/panel.js";

describe("panelDocsDir path containment", () => {
  const dataHome = "/home/u/.local/share/council";

  it("builds the docs dir for a valid kebab-case panel name", () => {
    expect(panelDocsDir(dataHome, "finance")).toBe(`${dataHome}/panels/finance/docs`);
  });

  it("rejects a panel name with parent-traversal segments", () => {
    expect(() => panelDocsDir(dataHome, "../../etc")).toThrow();
  });

  it("rejects a panel name containing a path separator", () => {
    expect(() => panelDocsDir(dataHome, "finance/../../etc")).toThrow();
  });

  it("rejects an absolute panel name", () => {
    expect(() => panelDocsDir(dataHome, "/etc/passwd")).toThrow();
  });

  it("rejects a panel name that resolves outside the panels root", () => {
    expect(() => panelDocsDir(dataHome, "..")).toThrow();
  });
});

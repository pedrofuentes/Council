/**
 * Path-containment guard for `panelDocsDir` (#1780).
 *
 * `panel docs list` and other sibling scanners build the managed docs dir
 * directly from `panel_library.name`, which may have been populated via
 * migration/import/DB edit that bypassed create-time validation. Without a
 * guard a name with traversal segments (e.g. `../../etc`) would make the
 * scanner index out-of-tree files. Mirror the `validatePanelName` +
 * `startsWith(panelsRoot + sep)` defense used by `resolveManagedDocsDir`.
 *
 * #1795 hardening:
 *   - the containment `startsWith` branch is exercised directly (it is
 *     shielded at runtime by `validatePanelName`, so it needs a dedicated
 *     test to be covered);
 *   - it throws `CliUserError` (a config/state problem → exit 1) rather than a
 *     bare `Error` (which the top-level handler maps to exit 4, "internal");
 *   - assertions check the thrown message instead of a bare `toThrow()`.
 */
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { assertContainedInPanelsRoot, panelDocsDir } from "../../../../src/cli/commands/panel.js";
import { CliUserError } from "../../../../src/cli/cli-user-error.js";

describe("panelDocsDir path containment", () => {
  const dataHome = "/home/u/.local/share/council";

  it("builds the docs dir for a valid kebab-case panel name", () => {
    expect(panelDocsDir(dataHome, "finance")).toBe(`${dataHome}/panels/finance/docs`);
  });

  it("rejects a panel name with parent-traversal segments", () => {
    expect(() => panelDocsDir(dataHome, "../../etc")).toThrow(/invalid panel name|kebab-case/i);
  });

  it("rejects a panel name containing a path separator", () => {
    expect(() => panelDocsDir(dataHome, "finance/../../etc")).toThrow(
      /invalid panel name|kebab-case/i,
    );
  });

  it("rejects an absolute panel name", () => {
    expect(() => panelDocsDir(dataHome, "/etc/passwd")).toThrow(/invalid panel name|kebab-case/i);
  });

  it("rejects a panel name that resolves outside the panels root", () => {
    expect(() => panelDocsDir(dataHome, "..")).toThrow(/invalid panel name|kebab-case/i);
  });
});

describe("assertContainedInPanelsRoot — containment startsWith branch", () => {
  const dataHome = "/home/u/.local/share/council";
  const panelsRoot = path.resolve(path.join(dataHome, "panels"));

  it("does not throw for a path inside the panels root", () => {
    const inside = path.join(dataHome, "panels", "finance", "docs");
    expect(() => assertContainedInPanelsRoot(inside, panelsRoot, "finance")).not.toThrow();
  });

  it("throws CliUserError with an actionable message when the path escapes the panels root", () => {
    const escaping = path.resolve(dataHome, "..", "etc", "docs");
    let thrown: unknown;
    try {
      assertContainedInPanelsRoot(escaping, panelsRoot, "evil");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliUserError);
    expect((thrown as Error).message).toMatch(/escapes panels directory/i);
    expect((thrown as Error).message).toContain('name="evil"');
  });

  it("throws for the panels root itself (a prefix, not a contained child)", () => {
    // `panelsRoot` (without a trailing separator) must NOT be treated as
    // contained — otherwise `<root>-evil` style siblings could slip through.
    expect(() => assertContainedInPanelsRoot(panelsRoot, panelsRoot, "root")).toThrow(CliUserError);
  });
});

describe("assertContainedInPanelsRoot — resolves an unresolved panelsRoot (#1931 item b)", () => {
  const dataHome = "/home/u/.local/share/council";
  const resolvedRoot = path.resolve(path.join(dataHome, "panels"));
  // A future caller might pass a NON-normalized but equivalent root. Build one
  // with a `..` round-trip (string concat, not `path.join`, so it stays
  // un-normalized): `<root>/../panels` resolves back to `<root>`.
  const unresolvedRoot = resolvedRoot + path.sep + ".." + path.sep + "panels";

  it("accepts a contained candidate even when panelsRoot is passed unresolved", () => {
    const inside = path.join(resolvedRoot, "finance", "docs");
    // Before the fix the guard compares the resolved candidate against the raw
    // (un-normalized) `unresolvedRoot + sep` prefix, which never matches — so a
    // legitimately-contained path is wrongly rejected. Resolving the root
    // internally restores containment for equivalent-but-unresolved roots.
    expect(() => assertContainedInPanelsRoot(inside, unresolvedRoot, "finance")).not.toThrow();
  });

  it("still rejects an escaping candidate when panelsRoot is passed unresolved", () => {
    const escaping = path.resolve(dataHome, "..", "etc", "docs");
    expect(() => assertContainedInPanelsRoot(escaping, unresolvedRoot, "evil")).toThrow(
      CliUserError,
    );
  });
});

/**
 * `panel docs list --refresh` — scan-failure diagnostic is terminal-safe
 * (#1931 item a, security-path).
 *
 * When the `--refresh` filesystem scan throws, `runDocsList` degrades to the
 * last known DB state and warns on stderr. That warning interpolates the raw
 * scan `err.message` (`panel.ts` docs-list catch sink). The scanner walks
 * managed/linked folders whose paths derive from `panel_library.name` — a
 * value that can be populated via migration/import/direct DB edit and is
 * therefore untrusted — so a crafted error message can smuggle
 * ANSI/OSC/C0/C1/DEL/bidi bytes straight onto the operator's terminal.
 *
 * These tests pin that the surfaced warning is control-free while still
 * conveying the legitimate "could not refresh" diagnostic.
 *
 * RED before the fix: the raw escapes reach stderr unsanitized.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The scanner is mocked so we can force it to throw an error whose message
// carries adversarial bytes, deterministically.
const scanControl = vi.hoisted(() => ({ throwMessage: null as string | null }));

import type * as ScannerModule from "../../../../src/core/documents/panel-document-scanner.js";

vi.mock("../../../../src/core/documents/panel-document-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScannerModule>();
  return {
    ...actual,
    scanAndIndexPanelDocuments: async (): Promise<ScannerModule.PanelScanResult> => {
      if (scanControl.throwMessage !== null) {
        throw new Error(scanControl.throwMessage);
      }
      return {
        indexed: 0,
        unchanged: 0,
        failed: 0,
        needsReview: 0,
        unsupported: 0,
        pruned: 0,
        foldersFailed: 0,
        managedFolderFailed: false,
        files: [],
      };
    },
  };
});

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createDatabase } from "../../../../src/memory/db.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Every codepoint class a terminal can be induced to (mis)interpret: C0
// controls (incl. CR/LF), DEL, C1 controls, the Unicode line/paragraph
// separators, and the bidi override/isolate marks. Matching any of these in a
// surfaced line means an escape survived to the terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Assert no line carries a terminal-injection control byte. Checking per line
 * allows the legitimate `\n` sentence separators the sink emits while still
 * catching a bare CR or any injected control char inside a line.
 */
function expectNoControlChars(text: string): void {
  for (const line of text.split("\n")) {
    expect(line).not.toMatch(CONTROL_RE);
  }
}

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
    epistemicStance: "Empirical",
    kind: "generic",
  };
}

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function createPanel(): Promise<void> {
  const cmd = buildPanelCommand(() => {
    /* noop */
  });
  await cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]);
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-list-san-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-list-san-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
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

async function runRefreshList(): Promise<{ out: string; err: string; error: unknown }> {
  let out = "";
  let err = "";
  const cmd = buildPanelCommand(
    (s) => {
      out += s;
    },
    (s) => {
      err += s;
    },
  );
  const error = await cmd
    .parseAsync(["node", "council-panel", "docs", "list", "arch-review", "--refresh"])
    .then(
      () => null,
      (e: unknown) => e,
    );
  return { out, err, error };
}

// Adversarial scan-error messages: each packs a distinct terminal-injection
// class alongside legitimate-looking text.
const ADVERSARIAL_MESSAGES: readonly { readonly label: string; readonly message: string }[] = [
  {
    // TAB, BEL (C0), C1 CSI (0x9B), DEL, RLO + LRI (bidi), CR, LF, and the
    // Unicode line/paragraph separators.
    label: "C0/C1/DEL/bidi/CR-LF/U+2028-U+2029",
    message: "scan failed:\t\u0007\u009b\u007f\u202e\u2066\r\n\u2028\u2029 boom",
  },
  {
    // ANSI CSI SGR sequence (colour reset spoofing).
    label: "ANSI CSI \\u001b[31m",
    message: "scan failed \u001b[31mHACKED\u001b[0m",
  },
  {
    // OSC set-window-title / hyperlink introducer, BEL-terminated.
    label: "OSC set-title",
    message: "scan failed \u001b]0;pwned\u0007",
  },
];

describe("panel docs list --refresh — scan-failure warning is terminal-safe (#1931 item a)", () => {
  let env: TestEnv;
  // The scan-throw path now sets a non-zero process.exitCode (#1931). Save and
  // restore it so this suite never leaves the global exit code dirty for other
  // suites that may run in the same worker.
  let savedExitCode: typeof process.exitCode;
  beforeEach(async () => {
    savedExitCode = process.exitCode;
    scanControl.throwMessage = null;
    env = await makeEnv();
    await seedExpert(env, expertDef("cto"));
    await createPanel();
  });
  afterEach(async () => {
    scanControl.throwMessage = null;
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
    await teardown(env);
  });

  it.each(ADVERSARIAL_MESSAGES)(
    "neutralizes injected escapes in the scan-failure warning ($label)",
    async ({ message }) => {
      scanControl.throwMessage = message;
      const { err, error } = await runRefreshList();

      // Graceful degradation is preserved: the listing does NOT crash.
      expect(error).toBeNull();
      // The legitimate diagnostic is still conveyed.
      expect(err).toMatch(/could not refresh/i);
      expect(err).toMatch(/stale/i);
      // No ANSI/OSC/C0/C1/DEL/bidi byte reaches the terminal (checked per line
      // so the legitimate `\n` sentence separators are allowed).
      expectNoControlChars(err);
      // The untrusted detail cannot inject extra lines: the two-sentence
      // warning stays exactly two lines (drop the sink's trailing newline).
      expect(err.replace(/\n$/, "").split("\n")).toHaveLength(2);
    },
  );

  it("keeps the diagnostic while dropping the exact injected bytes", async () => {
    scanControl.throwMessage = "boom \u001b[31m\u0007\u009b oops";
    const { err, error } = await runRefreshList();

    expect(error).toBeNull();
    expect(err).toMatch(/could not refresh/i);
    expect(err).not.toContain("\u001b[31m");
    expect(err).not.toContain("\u0007");
    expect(err).not.toContain("\u009b");
    expectNoControlChars(err);
  });
});

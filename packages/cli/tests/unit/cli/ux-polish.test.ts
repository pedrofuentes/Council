/**
 * Tests for T-20: UX polish findings (TUI-18, TUI-24, TUI-25, TUI-26, A11Y-16, A11Y-17, DX-11).
 *
 * RED at this commit: new symbols/colors/functions do not exist yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { copyTemplateDb } from "../../helpers/template-db.js";

import { buildExpertCommand } from "../../../src/cli/commands/expert.js";
import { createDatabase } from "../../../src/memory/db.js";
import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import { getSymbols } from "../../../src/cli/renderers/symbols.js";
import {
  isCostWarning,
  COST_WARNING_THRESHOLD,
} from "../../../src/cli/renderers/ink/InkRenderer.js";
import {
  HUMAN_COLOR,
  assignExpertColor,
  EXPERT_COLOR_PALETTE,
} from "../../../src/cli/renderers/ink/colors.js";
import { buildDoctorCommand } from "../../../src/cli/commands/doctor.js";
import { wrapLink } from "../../../src/cli/error-mapper.js";

// --- TUI-18: Human symbol in SymbolSet ---
describe("TUI-18: human symbol in SymbolSet", () => {
  it("getSymbols() includes a 'human' property in unicode mode", () => {
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    delete process.env.COUNCIL_ASCII;
    const s = getSymbols(false);
    expect(s).toHaveProperty("human");
    expect(s.human).toBe("👤");
  });

  it("getSymbols() includes '[H]' for human in ASCII mode", () => {
    const s = getSymbols(true);
    expect(s.human).toBe("[H]");
  });
});

// --- TUI-24: Cost indicator warning color ---
describe("TUI-24: CostIndicator warning color at high ratio", () => {
  it("isCostWarning returns true when ratio exceeds threshold", () => {
    expect(COST_WARNING_THRESHOLD).toBe(0.8);
    // Above threshold → warning
    expect(isCostWarning(81, 100)).toBe(true);
    expect(isCostWarning(90, 100)).toBe(true);
    // At or below threshold → no warning
    expect(isCostWarning(80, 100)).toBe(false);
    expect(isCostWarning(50, 100)).toBe(false);
  });

  it("isCostWarning handles zero/invalid estimatedTotal safely", () => {
    // Zero denominator → false (no crash)
    expect(isCostWarning(10, 0)).toBe(false);
    // Negative denominator → false
    expect(isCostWarning(10, -1)).toBe(false);
  });
});

// --- TUI-25: Reserved HUMAN_COLOR ---
describe("TUI-25: HUMAN_COLOR constant and assignExpertColor isHuman param", () => {
  it("exports HUMAN_COLOR from colors.ts", () => {
    expect(HUMAN_COLOR).toBe("whiteBright");
  });

  it("assignExpertColor returns HUMAN_COLOR when isHuman is true", () => {
    const color = assignExpertColor(0, { isHuman: true });
    expect(color).toBe(HUMAN_COLOR);
  });

  it("assignExpertColor returns palette color when isHuman is false", () => {
    const color = assignExpertColor(0, { isHuman: false });
    expect(color).toBe(EXPERT_COLOR_PALETTE[0]);
  });

  it("assignExpertColor without options preserves old behavior", () => {
    const color = assignExpertColor(2);
    expect(color).toBe(EXPERT_COLOR_PALETTE[2]);
  });
});

// --- TUI-26: InkRenderer accepts stdout/stderr for Sink testing ---
describe("TUI-26: InkRenderer accepts stdout/stderr streams", () => {
  afterEach(() => {
    // Undo the scoped "ink" mock + fresh module registry from the test below
    // so later dynamic imports (in this file or others) see the real "ink".
    vi.doUnmock("ink");
    vi.resetModules();
  });

  it("InkRenderer fallback (on ink init failure) writes to the InkRenderer-provided stdout/stderr Sink — not a directly-constructed PlainRenderer", async () => {
    // Force ink's render() to throw synchronously, simulating a ConPTY/MinTTY
    // initialization failure — the same trigger ink-fallback.test.ts uses for
    // InkRenderer's A11Y-14 fallback-to-PlainRenderer path. Scoped via
    // vi.doMock + resetModules (not a file-level vi.mock) so it doesn't
    // affect this file's other, unrelated describe blocks.
    vi.doMock("ink", () => ({
      Box: "div",
      Text: "span",
      Static: (_props: { children: (item: unknown) => unknown; items: unknown[] }) => null,
      render: () => {
        throw new Error("ConPTY pseudo-console unavailable");
      },
    }));
    vi.resetModules();

    const { InkRenderer: FallbackInkRenderer } =
      await import("../../../src/cli/renderers/ink/InkRenderer.js");

    let stdoutOutput = "";
    let stderrOutput = "";
    const fakeStdout = new Writable({
      write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
        stdoutOutput += chunk.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    Object.defineProperty(fakeStdout, "columns", { value: 80 });
    const fakeStderr = new Writable({
      write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
        stderrOutput += chunk.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;

    const renderer = new FallbackInkRenderer({
      stdout: fakeStdout,
      stderr: fakeStderr,
      isTTY: true,
    });
    const events = (async function* () {
      yield {
        kind: "panel.assembled" as const,
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5", participantKind: "ai" as const },
        ],
      };
      yield { kind: "debate.end" as const, reason: "max_rounds" as const };
    })();
    await renderer.render(events);

    // Discriminates the InkRenderer fallback path specifically: this warning
    // is written ONLY from InkRenderer's catch block
    // (src/cli/renderers/ink/InkRenderer.tsx) — a PlainRenderer instantiated
    // directly (the bug this test used to have, per #715) never emits it, so
    // this assertion fails if the test regresses to constructing
    // PlainRenderer directly instead of driving it through InkRenderer.
    expect(stderrOutput).toContain("[WARN]");
    expect(stderrOutput).toContain("falling back to plain text");
    // The fallback's PlainRenderer output must be routed through the SAME
    // stdout stream the InkRenderer instance was constructed with.
    expect(stdoutOutput).toContain("Alice");
    expect(stdoutOutput).toContain("Debate complete");
  });
});

// --- A11Y-16: Doctor terminal capability section ---
describe("A11Y-16: doctor terminal capability info", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("doctor output includes Terminal section with env vars", async () => {
    process.env.TERM = "xterm-256color";
    process.env.COLORTERM = "truecolor";
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;

    let captured = "";
    const cmd = buildDoctorCommand({
      write: (s: string) => { captured += s; },
    });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "council-doctor"]).catch(() => undefined);

    expect(captured).toContain("Terminal");
    expect(captured).toContain("TERM");
    expect(captured).toContain("xterm-256color");
  });
});

// --- A11Y-17: OSC-8 hyperlinks ---
describe("A11Y-17: wrapLink OSC-8 helper", () => {
  it("exports wrapLink function from error-mapper", () => {
    expect(typeof wrapLink).toBe("function");
  });

  it("wrapLink returns plain text when stream is not TTY", () => {
    const result = wrapLink("https://example.com", "click here", { isTTY: false });
    expect(result).toBe("click here");
  });

  it("wrapLink returns plain URL when no text and not TTY", () => {
    const result = wrapLink("https://example.com", undefined, { isTTY: false });
    expect(result).toBe("https://example.com");
  });

  it("wrapLink wraps URL with OSC-8 when stream is TTY", () => {
    const origTerm = process.env.TERM;
    process.env.TERM = "xterm-256color";
    try {
      const result = wrapLink("https://example.com", "click", { isTTY: true });
      expect(result).toBe("\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\");
    } finally {
      if (origTerm === undefined) delete process.env.TERM;
      else process.env.TERM = origTerm;
    }
  });

  it("wrapLink degrades on TERM=dumb even if TTY", () => {
    const origTerm = process.env.TERM;
    process.env.TERM = "dumb";
    try {
      const result = wrapLink("https://example.com", "click", { isTTY: true });
      expect(result).toBe("click");
    } finally {
      if (origTerm === undefined) delete process.env.TERM;
      else process.env.TERM = origTerm;
    }
  });
});

// --- DX-11: Expert delete --force confirmation improvement ---
describe("DX-11: expert delete --force lists affected panels", () => {
  it("--force --yes output mentions panel names before deletion", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-dx11-home-"));
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-dx11-data-"));
    const origHome = process.env["COUNCIL_HOME"];
    const origDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = home;
    process.env["COUNCIL_DATA_HOME"] = dataHome;

    try {
      await copyTemplateDb(path.join(home, "council.db"));
      const db = await createDatabase(path.join(home, "council.db"));
      const lib = new FileExpertLibrary(dataHome, db);
      await lib.create({
        slug: "test-cto",
        displayName: "Test CTO",
        role: "CTO",
        expertise: { weightedEvidence: ["arch"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "pragmatic",
        kind: "generic",
      });

      await db
        .insertInto("panel_library")
        .values({
          name: "arch-review",
          yaml_path: path.join(dataHome, "panels", "arch-review.yaml"),
          yaml_checksum: "x",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
      await db
        .insertInto("panel_members")
        .values({
          panel_name: "arch-review",
          expert_slug: "test-cto",
          position: 0,
          created_at: new Date().toISOString(),
        })
        .execute();
      await db.destroy();

      let captured = "";
      const cmd = buildExpertCommand((s: string) => {
        captured += s;
      });
      cmd.exitOverride();
      await cmd.parseAsync(["node", "council-expert", "delete", "test-cto", "--force", "--yes"]);

      expect(captured).toMatch(/arch-review/);
      expect(captured).toMatch(/deleted/i);
    } finally {
      if (origHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = origHome;
      if (origDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = origDataHome;
      // Best-effort cleanup with a BOUNDED retry budget. On Windows, @libsql
      // releases the council.db `-wal`/`-shm` handles slightly after
      // `db.destroy()`, so an immediate `rm` hits transient EPERM/EBUSY.
      // Node's fs.rm backoff is `retryDelay * 2^attempt` PER locked file, so a
      // wide budget (e.g. 5 × 200 ms) compounds to ~20 s across the three
      // SQLite files and pushes this test over its timeout. Mirror the proven
      // sibling teardown (panel-delete.test.ts) — 3 × 50 ms gives up fast.
      await fs
        .rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        .catch(() => {
          /* best-effort */
        });
      await fs
        .rm(dataHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        .catch(() => {
          /* best-effort */
        });
    }
  }, 30_000);
});

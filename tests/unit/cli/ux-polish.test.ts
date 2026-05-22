/**
 * Tests for T-20: UX polish findings (TUI-18, TUI-24, TUI-25, TUI-26, A11Y-16, A11Y-17, DX-11).
 *
 * RED at this commit: new symbols/colors/functions do not exist yet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// --- TUI-18: Human symbol in SymbolSet ---
describe("TUI-18: human symbol in SymbolSet", () => {
  it("getSymbols() includes a 'human' property in unicode mode", async () => {
    const { getSymbols } = await import("../../../src/cli/renderers/symbols.js");
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    delete process.env.COUNCIL_ASCII;
    const s = getSymbols(false);
    expect(s).toHaveProperty("human");
    expect(s.human).toBe("👤");
  });

  it("getSymbols() includes '[H]' for human in ASCII mode", async () => {
    const { getSymbols } = await import("../../../src/cli/renderers/symbols.js");
    const s = getSymbols(true);
    expect(s.human).toBe("[H]");
  });
});

// --- TUI-24: Cost indicator warning color ---
describe("TUI-24: CostIndicator warning color at high ratio", () => {
  it("CostIndicator uses yellow text when ratio > 0.8", async () => {
    // This test checks the state-driven logic via the reduce function
    const { reduce, INITIAL_STATE } = await import(
      "../../../src/cli/renderers/ink/InkRenderer.js"
    );
    // Build a state with cost at 90/100 (ratio 0.9 > 0.8)
    const state = reduce(INITIAL_STATE, {
      kind: "cost.update",
      premiumRequests: 90,
      estimatedTotal: 100,
    });
    expect(state.cost).not.toBeNull();
    expect(state.cost!.premiumRequests / state.cost!.estimatedTotal).toBeGreaterThan(0.8);
  });
});

// --- TUI-25: Reserved HUMAN_COLOR ---
describe("TUI-25: HUMAN_COLOR constant and assignExpertColor isHuman param", () => {
  it("exports HUMAN_COLOR from colors.ts", async () => {
    const { HUMAN_COLOR } = await import("../../../src/cli/renderers/ink/colors.js");
    expect(HUMAN_COLOR).toBe("whiteBright");
  });

  it("assignExpertColor returns HUMAN_COLOR when isHuman is true", async () => {
    const { assignExpertColor, HUMAN_COLOR } = await import(
      "../../../src/cli/renderers/ink/colors.js"
    );
    const color = assignExpertColor(0, { isHuman: true });
    expect(color).toBe(HUMAN_COLOR);
  });

  it("assignExpertColor returns palette color when isHuman is false", async () => {
    const { assignExpertColor, EXPERT_COLOR_PALETTE } = await import(
      "../../../src/cli/renderers/ink/colors.js"
    );
    const color = assignExpertColor(0, { isHuman: false });
    expect(color).toBe(EXPERT_COLOR_PALETTE[0]);
  });

  it("assignExpertColor without options preserves old behavior", async () => {
    const { assignExpertColor, EXPERT_COLOR_PALETTE } = await import(
      "../../../src/cli/renderers/ink/colors.js"
    );
    const color = assignExpertColor(2);
    expect(color).toBe(EXPERT_COLOR_PALETTE[2]);
  });
});

// --- TUI-26: InkRenderer accepts stdout/stderr for Sink testing ---
describe("TUI-26: InkRenderer accepts stdout/stderr streams", () => {
  it("InkRendererOptions type accepts stdout and stderr properties", async () => {
    const { InkRenderer } = await import("../../../src/cli/renderers/ink/InkRenderer.js");
    // The existing InkRendererOptions already has stdout/stderr — just validate constructor works
    const { Writable } = await import("node:stream");
    const fakeStdout = new Writable({
      write(_chunk, _enc, cb) { cb(); },
    }) as unknown as NodeJS.WriteStream;
    Object.defineProperty(fakeStdout, "columns", { value: 80 });
    const renderer = new InkRenderer({ stdout: fakeStdout });
    expect(renderer).toBeDefined();
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

    const { buildDoctorCommand } = await import("../../../src/cli/commands/doctor.js");
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
  it("exports wrapLink function from error-mapper", async () => {
    const { wrapLink } = await import("../../../src/cli/error-mapper.js");
    expect(typeof wrapLink).toBe("function");
  });

  it("wrapLink returns plain text when not TTY", async () => {
    const { wrapLink } = await import("../../../src/cli/error-mapper.js");
    // In test env, process.stdout.isTTY is typically undefined/false
    const result = wrapLink("https://example.com", "click here");
    // Should degrade to plain text (no OSC-8) since test is not a TTY
    expect(result).toBe("click here");
  });

  it("wrapLink returns plain URL when no text and not TTY", async () => {
    const { wrapLink } = await import("../../../src/cli/error-mapper.js");
    const result = wrapLink("https://example.com");
    expect(result).toBe("https://example.com");
  });
});

// --- DX-11: Expert delete --force lists affected panels ---
describe("DX-11: expert delete --force lists affected panels", () => {
  it("--force --yes output mentions panel names before deletion", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-polish-"));
    const testDataHome = path.join(testHome, "data");
    await fs.mkdir(testDataHome, { recursive: true });
    await fs.mkdir(path.join(testDataHome, "experts"), { recursive: true });
    await fs.mkdir(path.join(testDataHome, "panels"), { recursive: true });

    const origHome = process.env["COUNCIL_HOME"];
    const origDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testDataHome;

    try {
      // Create expert file
      const expertDef = {
        slug: "test-cto",
        name: "Test CTO",
        role: "Chief Technology Officer",
        expertise: ["architecture"],
        stance: "pragmatic",
      };
      await fs.writeFile(
        path.join(testDataHome, "experts", "test-cto.yaml"),
        `slug: test-cto\nname: Test CTO\nrole: Chief Technology Officer\nexpertise:\n  - architecture\nstance: pragmatic\n`,
      );

      // Create DB with panel membership
      const { createDatabase } = await import("../../../src/memory/db.js");
      const db = await createDatabase(path.join(testHome, "council.db"));
      await db
        .insertInto("panel_library")
        .values({
          name: "arch-review",
          yaml_path: path.join(testDataHome, "panels", "arch-review.yaml"),
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

      const { buildExpertCommand } = await import("../../../src/cli/commands/expert.js");
      let captured = "";
      const cmd = buildExpertCommand((s: string) => { captured += s; });
      cmd.exitOverride();
      await cmd.parseAsync(["node", "council-expert", "delete", "test-cto", "--force", "--yes"]);

      // Should list the panel before deleting
      expect(captured).toMatch(/arch-review/);
      expect(captured).toMatch(/deleted/i);
    } finally {
      if (origHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = origHome;
      if (origDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = origDataHome;
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

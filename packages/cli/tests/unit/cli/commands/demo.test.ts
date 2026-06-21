/**
 * Tests for `council demo` (T-growth-5) — a zero-setup, deterministic
 * showcase of a Council panel deliberation.
 *
 * The demo must run with NO Copilot login, NO API keys, NO network access,
 * and NO database writes, so a brand-new user can see Council's value in a
 * single command. It is driven by the in-memory MockEngine, so the
 * transcript is deterministic and safe to assert on here.
 *
 * RED at this commit: src/cli/commands/demo.ts does not exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDemoCommand,
  createDemoEngine,
  DEMO_SCRIPT,
  DEMO_TOPIC,
} from "../../../../src/cli/commands/demo.js";
import { buildProgram } from "../../../../src/bin/council.js";
import { CopilotEngine } from "../../../../src/engine/copilot/adapter.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";

// Personas reused from the built-in `startup-validation` panel — the demo
// must NOT invent its own personas (it showcases a real built-in panel).
const PANEL_DISPLAY_NAMES = [
  "Sasha Lin (VC Partner)",
  "Erin Boateng",
  "Riveira (Existing Competitor)",
  "Kai Adeyemi (Distribution Expert)",
] as const;
const PANEL_SLUGS = ["vc", "customer", "competitor", "distribution"] as const;

interface ParsedDebateEvent {
  readonly kind: string;
  readonly content?: string;
  readonly experts?: readonly { readonly slug: string; readonly displayName: string }[];
}

function captureWriter(): { readonly write: (s: string) => void; read: () => string } {
  let text = "";
  return {
    write: (s: string): void => {
      text += s;
    },
    read: (): string => text,
  };
}

function parseNdjson(text: string): ParsedDebateEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as ParsedDebateEvent);
}

describe("buildDemoCommand", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Deterministic, color-free output for substring assertions.
    process.env["NO_COLOR"] = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers a 'demo' command with a --format option and no required args", () => {
    const cmd = buildDemoCommand();
    expect(cmd.name()).toBe("demo");
    expect(cmd.description()).toMatch(/demo|showcase|offline|try/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--format");
  });

  it("is wired into the root program as a top-level subcommand", () => {
    const program = buildProgram();
    const demo = program.commands.find((c) => c.name() === "demo");
    expect(demo).toBeDefined();
  });

  it("defaults to the in-memory MockEngine and never the Copilot engine", () => {
    const engine: CouncilEngine = createDemoEngine();
    expect(engine).toBeInstanceOf(MockEngine);
    expect(engine).not.toBeInstanceOf(CopilotEngine);
  });

  it("renders the reused built-in panel header and a scripted expert turn (plain)", async () => {
    const out = captureWriter();
    const cmd = buildDemoCommand({ write: out.write, writeError: () => undefined });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-demo", "--format", "plain"]);

    const text = out.read();
    // Panel header lists the reused personas.
    expect(text).toContain("Panel assembled");
    for (const name of PANEL_DISPLAY_NAMES) expect(text).toContain(name);
    // At least one real expert turn rendered with its scripted content.
    expect(text).toContain(DEMO_SCRIPT["vc"] as string);
    // Transcript framing + the fixed sample topic.
    expect(text).toContain(DEMO_TOPIC);
    expect(text).toContain("Debate complete");
    // One-line pointer to next steps.
    expect(text).toMatch(/council convene/i);
  });

  it("emits machine-readable NDJSON with --format json (pure stdout)", async () => {
    const out = captureWriter();
    const cmd = buildDemoCommand({ write: out.write, writeError: () => undefined });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-demo", "--format", "json"]);

    const events = parseNdjson(out.read());
    expect(events.length).toBeGreaterThan(0);
    // Every non-empty stdout line is valid JSON (no human framing leaked).
    for (const line of out.read().split("\n").filter((l) => l.trim().length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(out.read()).not.toMatch(/council convene/);

    expect(events[0]?.kind).toBe("panel.assembled");
    expect(events[events.length - 1]?.kind).toBe("debate.end");

    const roster = events[0]?.experts ?? [];
    const slugs = roster.map((e) => e.slug);
    for (const slug of PANEL_SLUGS) expect(slugs).toContain(slug);

    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    for (const turn of turnEnds) {
      expect(typeof turn.content).toBe("string");
      expect((turn.content ?? "").length).toBeGreaterThan(0);
    }
  });

  it("runs with no auth/keys/home env and is deterministic (zero-setup)", async () => {
    // Simulate a brand-new machine: no Copilot auth, no config/data home.
    delete process.env["COUNCIL_HOME"];
    delete process.env["COUNCIL_DATA_HOME"];
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
    delete process.env["COPILOT_API_KEY"];

    const first = captureWriter();
    const cmdA = buildDemoCommand({ write: first.write, writeError: () => undefined });
    cmdA.exitOverride();
    await cmdA.parseAsync(["node", "council-demo", "--format", "plain"]);

    const second = captureWriter();
    const cmdB = buildDemoCommand({ write: second.write, writeError: () => undefined });
    cmdB.exitOverride();
    await cmdB.parseAsync(["node", "council-demo", "--format", "plain"]);

    expect(first.read().length).toBeGreaterThan(0);
    // Deterministic: identical output across runs with no environment setup.
    expect(first.read()).toBe(second.read());
  });

  it("uses only the injected engine (proves no network engine is constructed)", async () => {
    const constructed: CouncilEngine[] = [];
    const engineFactory = (): CouncilEngine => {
      const engine = createDemoEngine();
      constructed.push(engine);
      return engine;
    };

    const cmd = buildDemoCommand({
      engineFactory,
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    await cmd.parseAsync(["node", "council-demo", "--format", "plain"]);

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toBeInstanceOf(MockEngine);
    expect(constructed[0]).not.toBeInstanceOf(CopilotEngine);
  });
});

/**
 * Tests for ASCII symbol integration across renderers.
 *
 * RED at this commit: renderers still use hardcoded Unicode symbols
 * and do not import from symbols.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../../src/core/types.js";
import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";
import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import { buildDoctorCommand } from "../../../../src/cli/commands/doctor.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

class StringSink {
  text = "";
  errText = "";
  write(s: string): void {
    this.text += s;
  }
  writeError(s: string): void {
    this.errText += s;
  }
}

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

// Strip ANSI escape sequences for assertion convenience.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("PlainRenderer with ASCII mode", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.COUNCIL_ASCII = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses ASCII panel symbol when COUNCIL_ASCII=1", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "panel.assembled",
        experts: [
          { slug: "cto", displayName: "CTO", model: "claude-sonnet-4" },
        ],
      }),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("[Panel]");
    expect(text).not.toContain("🏛️");
  });

  it("uses ASCII round rule when COUNCIL_ASCII=1", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({ kind: "round.start", round: 0 }),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("--- Round 1 ---");
    expect(text).not.toContain("━");
  });

  it("uses ASCII separator when COUNCIL_ASCII=1", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({ kind: "round.end", round: 0 }),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("-".repeat(40));
    expect(text).not.toContain("─");
  });

  it("uses ASCII bullet in expert list when COUNCIL_ASCII=1", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "panel.assembled",
        experts: [
          { slug: "cto", displayName: "CTO", model: "claude-sonnet-4" },
        ],
      }),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("*");
    expect(text).not.toContain("•");
  });
});

describe("ChatRenderer with ASCII mode", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.COUNCIL_ASCII = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses ASCII info symbol when COUNCIL_ASCII=1", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSystem("hello", "info");
    const text = stripAnsi(sink.text);
    expect(text).toContain("[i]");
    expect(text).not.toContain("ℹ");
  });

  it("uses ASCII warn symbol when COUNCIL_ASCII=1", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSystem("warning", "warn");
    const text = stripAnsi(sink.text);
    expect(text).toContain("[WARN]");
    expect(text).not.toContain("⚠");
  });

  it("uses ASCII error symbol when COUNCIL_ASCII=1", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSystem("bad", "error");
    const text = stripAnsi(sink.errText);
    expect(text).toContain("[x]");
    expect(text).not.toContain("✗");
  });

  it("uses ASCII separator when COUNCIL_ASCII=1", () => {
    const sink = new StringSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["a", "Alice"]]),
    });
    renderer.showSeparator();
    const text = stripAnsi(sink.text);
    expect(text).toContain("-".repeat(40));
    expect(text).not.toContain("─");
  });
});

describe("Doctor command with ASCII mode", () => {
  const originalEnv = { ...process.env };
  let testHome: string;

  beforeEach(async () => {
    process.env.COUNCIL_ASCII = "1";
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-ascii-"));
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("uses ASCII header rule when COUNCIL_ASCII=1", async () => {
    let captured = "";
    const write: Writer = (chunk: string) => {
      captured += chunk;
    };
    const cmd = buildDoctorCommand({ write });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "council-doctor"]).catch(() => undefined);
    expect(captured).toContain("=".repeat(40));
    expect(captured).not.toContain("═");
  });

  it("uses ASCII status icons with text labels when COUNCIL_ASCII=1", async () => {
    let captured = "";
    const write: Writer = (chunk: string) => {
      captured += chunk;
    };
    const cmd = buildDoctorCommand({ write });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "council-doctor"]).catch(() => undefined);
    // Should contain text labels like "[OK] PASS" or "[FAIL] FAIL"
    expect(captured).toMatch(/\[(OK|FAIL|WARN)\] (PASS|FAIL|WARN)/);
    expect(captured).not.toContain("✅");
    expect(captured).not.toContain("❌");
  });
});

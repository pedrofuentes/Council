/**
 * Tests for A11Y-14: InkRenderer fallback when ink crashes.
 *
 * Uses vi.mock to make ink's render() throw synchronously, simulating
 * ConPTY / MinTTY initialization failures.
 */
import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";

vi.mock("ink", () => ({
  Box: "div",
  Text: "span",
  Static: (_props: { children: (item: unknown) => unknown; items: unknown[] }) => null,
  render: () => {
    throw new Error("ConPTY pseudo-console unavailable");
  },
}));

import { InkRenderer } from "../../../../../src/cli/renderers/ink/InkRenderer.js";

describe("A11Y-14: InkRenderer fallback on ink crash (mocked)", () => {
  it("catches ink initialization failure and falls back to PlainRenderer", async () => {
    let stderrOutput = "";
    let stdoutOutput = "";

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

    const renderer = new InkRenderer({
      stdout: fakeStdout,
      stderr: fakeStderr,
      isTTY: true,
    });

    async function* events() {
      yield {
        kind: "panel.assembled" as const,
        experts: [{ slug: "a", displayName: "A", model: "m" }],
      };
      yield { kind: "debate.end" as const, reason: "complete" as const };
    }

    // Should NOT throw — fallback catches and uses PlainRenderer
    await expect(renderer.render(events())).resolves.toBeUndefined();
    // Verify warning was emitted to stderr
    expect(stderrOutput).toContain("[WARN]");
    expect(stderrOutput).toContain("ConPTY pseudo-console unavailable");
    expect(stderrOutput).toContain("falling back to plain text");
    // Verify PlainRenderer rendered the panel
    expect(stdoutOutput).toContain("Panel assembled");
  });
});

/**
 * Tests for A11Y-14: InkRenderer fallback when ink crashes.
 *
 * Uses vi.mock to make ink's render() throw synchronously, simulating
 * ConPTY / MinTTY initialization failures.
 */
import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";

const inkRenderMock = vi.hoisted(() => vi.fn());

vi.mock("ink", () => ({
  Box: "div",
  Text: "span",
  Static: (_props: { children: (item: unknown) => unknown; items: unknown[] }) => null,
  render: inkRenderMock,
}));

import { InkRenderer } from "../../../../../src/cli/renderers/ink/InkRenderer.js";

function createFakeWriteStream(onWrite: (chunk: string) => void): NodeJS.WriteStream {
  return new Writable({
    write(chunk: Buffer | string, _enc: string, cb: (err?: Error | null) => void) {
      onWrite(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

describe("A11Y-14: InkRenderer fallback on ink crash (mocked)", () => {
  it("catches ink initialization failure and falls back to PlainRenderer", async () => {
    let stderrOutput = "";
    let stdoutOutput = "";

    inkRenderMock.mockImplementation(() => {
      throw new Error("ConPTY pseudo-console unavailable");
    });

    const fakeStdout = createFakeWriteStream((chunk) => {
      stdoutOutput += chunk;
    });
    Object.defineProperty(fakeStdout, "columns", { value: 80 });

    const fakeStderr = createFakeWriteStream((chunk) => {
      stderrOutput += chunk;
    });

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

describe("InkRenderer unmount diagnostics (mocked)", () => {
  it("writes a sanitized teardown diagnostic to stderr and still resolves when unmount throws", async () => {
    let stderrOutput = "";
    const fakeStdout = createFakeWriteStream(() => undefined);
    const fakeStderr = createFakeWriteStream((chunk) => {
      stderrOutput += chunk;
    });
    inkRenderMock.mockReturnValue({
      unmount: () => {
        throw new Error("teardown\r\n\x1b[31mspoof\u202efailed");
      },
      waitUntilExit: () => Promise.resolve(),
    });

    const renderer = new InkRenderer({
      stdout: fakeStdout,
      stderr: fakeStderr,
      isTTY: false,
    });

    async function* noEvents(): AsyncGenerator<never> {
      yield* [];
    }

    await expect(renderer.render(noEvents())).resolves.toBeUndefined();

    expect(stderrOutput).toContain("teardown spooffailed");
    expect(stderrOutput).not.toContain("\r");
    expect(stderrOutput).not.toContain("\n\x1b[31m");
    expect(stderrOutput).not.toContain("\u202e");
  });
});

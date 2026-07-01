import path from "node:path";

import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ExportViewSource } from "../../../src/tui/adapters/export-view.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ExportOverlay } from "../../../src/tui/screens/ExportOverlay.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
};

// A lone Esc is buffered behind Ink's escape-disambiguation timeout, so give it
// a real-timer wait before flushing (mirrors the ConclusionScreen suite).
const pressEscape = async (stdin: { readonly write: (data: string) => void }): Promise<void> => {
  stdin.write(ESC);
  await new Promise((r) => setTimeout(r, 140));
  await flush();
};

const ENTER = "\r";
const ESC = "\u001b";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function BackProbe(): React.ReactElement {
  return <Text>BACK ROUTE</Text>;
}

function buildTree(options: {
  readonly export?: ExportViewSource;
  readonly panelName?: string;
}): React.ReactElement {
  const value = {
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    ...(options.export !== undefined ? { export: options.export } : {}),
  } as TuiDataSources;
  const panelName = options.panelName ?? "Acme";

  return (
    <InputCaptureProvider>
      <DataProvider value={value}>
        <MemoryRouter
          initialEntries={["/previous", { pathname: "/sessions/p1/export", state: { panelName } }]}
          initialIndex={1}
        >
          <Routes>
            <Route path="/previous" element={<BackProbe />} />
            <Route path="/sessions/:id/export" element={<ExportOverlay theme={theme} isActive />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>
  );
}

function renderScreen(options: {
  readonly export?: ExportViewSource;
  readonly panelName?: string;
}): ReturnType<typeof render> {
  return render(buildTree(options));
}

describe("ExportOverlay format picker", () => {
  it("lists every export format (markdown, json, adr, share)", async () => {
    const { lastFrame } = renderScreen({
      export: { render: async () => "preview", writeFile: vi.fn(async () => undefined) },
    });

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/markdown/i);
    expect(frame).toMatch(/json/i);
    expect(frame).toMatch(/adr/i);
    expect(frame).toMatch(/share/i);
  });
});

describe("ExportOverlay renders the chosen format", () => {
  const cases: readonly { readonly format: string; readonly steps: string }[] = [
    { format: "markdown", steps: "" },
    { format: "json", steps: "j" },
    { format: "adr", steps: "jj" },
    { format: "share", steps: "jjj" },
  ];

  for (const { format, steps } of cases) {
    it(`renders the ${format} preview when it is selected`, async () => {
      const renderFn = vi.fn(async (_panel: string, fmt: string) => `PREVIEW:${fmt}`);
      const { stdin, lastFrame } = renderScreen({
        export: { render: renderFn, writeFile: vi.fn(async () => undefined) },
      });

      await flush();
      for (const key of steps) stdin.write(key);
      stdin.write(ENTER);
      await flush();

      expect(renderFn).toHaveBeenCalledWith("Acme", format, undefined);
      expect(lastFrame() ?? "").toContain(`PREVIEW:${format}`);
    });
  }
});

describe("ExportOverlay write gate", () => {
  it("writes the rendered preview to the derived path when confirmed", async () => {
    const writeFile = vi.fn(async () => undefined);
    const { stdin, lastFrame } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile },
    });

    await flush();
    stdin.write(ENTER); // choose markdown -> preview
    await flush();
    stdin.write(ENTER); // confirm write
    await flush();

    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith("acme-markdown.md", "DOC BODY");
    expect(lastFrame() ?? "").toMatch(/acme-markdown\.md/);
  });

  it("does not write a second time while a write is in flight (inFlight gate bites)", async () => {
    let resolveWrite: () => void = () => undefined;
    const writeFile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const { stdin } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile },
    });

    await flush();
    stdin.write(ENTER); // choose markdown -> preview
    await flush();
    stdin.write(ENTER); // start write (in flight, unresolved)
    await flush();
    stdin.write(ENTER); // attempt a second write while the first is pending
    await flush();

    // Without the !inFlight guard the second Enter would fire writeFile again.
    expect(writeFile).toHaveBeenCalledOnce();
    resolveWrite();
    await flush();
  });

  it("does not write when there is no transcript to export (loaded gate bites)", async () => {
    const writeFile = vi.fn(async () => undefined);
    const { stdin, lastFrame } = renderScreen({
      export: { render: async () => null, writeFile },
    });

    await flush();
    stdin.write(ENTER); // choose markdown -> resolves to "unavailable"
    await flush();
    stdin.write(ENTER); // attempt to write with nothing loaded

    await flush();

    expect(writeFile).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").toMatch(/no transcript/i);
  });

  it("surfaces a sanitized error when the write fails", async () => {
    const writeFile = vi.fn(async () => {
      throw new Error("disk full\u0007\nplease");
    });
    const { stdin, lastFrame } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile },
    });

    await flush();
    stdin.write(ENTER); // preview
    await flush();
    stdin.write(ENTER); // write -> rejects
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/disk full/);
    expect(frame).not.toContain("\u0007");
  });
});

describe("ExportOverlay escape handling", () => {
  it("returns to the previous route on Escape from the picker (back-stack bite)", async () => {
    const { stdin, lastFrame } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile: vi.fn(async () => undefined) },
    });

    await flush();
    expect(lastFrame() ?? "").not.toContain("BACK ROUTE");

    await pressEscape(stdin);

    expect(lastFrame() ?? "").toContain("BACK ROUTE");
  });

  it("returns to the previous route on Escape from the preview", async () => {
    const { stdin, lastFrame } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile: vi.fn(async () => undefined) },
    });

    await flush();
    stdin.write(ENTER); // preview
    await flush();
    await pressEscape(stdin);

    expect(lastFrame() ?? "").toContain("BACK ROUTE");
  });

  it("does not navigate away while a write is in flight (Esc idle-gate bites)", async () => {
    let resolveWrite: () => void = () => undefined;
    const writeFile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const { stdin, lastFrame } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile },
    });

    await flush();
    stdin.write(ENTER); // preview
    await flush();
    stdin.write(ENTER); // write in flight
    await flush();
    stdin.write(ESC); // must be swallowed while writing
    await new Promise((r) => setTimeout(r, 140));
    await flush();

    expect(lastFrame() ?? "").not.toContain("BACK ROUTE");
    resolveWrite();
    await flush();
  });
});

describe("ExportOverlay sanitizes the preview sink", () => {
  it("collapses CR/LF/U+2028 and strips control chars in each preview row", async () => {
    const { stdin, lastFrame } = renderScreen({
      export: {
        render: async () => "row1\u0007\nrow2\rSPOOF\u2028X",
        writeFile: vi.fn(async () => undefined),
      },
    });

    await flush();
    stdin.write(ENTER); // preview
    await flush();

    const frame = lastFrame() ?? "";
    // The screen sink must use toSingleLineDisplay per row: BEL stripped, and the
    // CR / U+2028 row-spoofing chars collapsed to a space. stripControlChars would
    // leave \r and \u2028 intact, so this assertion bites a wrong sanitizer.
    expect(frame).toContain("row2 SPOOF X");
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("\u2028");
    expect(frame).not.toContain("row2\rSPOOF");
  });
});

describe("ExportOverlay without a data source", () => {
  it("renders an unavailable state and Escapes back without crashing", async () => {
    const { stdin, lastFrame } = renderScreen({});

    await flush();
    expect(lastFrame() ?? "").toMatch(/export/i);

    await pressEscape(stdin);

    expect(lastFrame() ?? "").toContain("BACK ROUTE");
  });
});

describe("ExportOverlay surfaces transcript load failures (Sentinel #1694 §2)", () => {
  it("shows the real error when the transcript render throws — not a false 'No transcript'", async () => {
    const renderFn = vi.fn(async () => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });
    const { stdin, lastFrame } = renderScreen({
      export: { render: renderFn, writeFile: vi.fn(async () => undefined) },
    });

    await flush();
    stdin.write(ENTER); // select markdown -> render rejects
    await flush();

    const frame = lastFrame() ?? "";
    // The unexpected failure must be surfaced verbatim, never masked as the
    // empty "No transcript" state (which reads as "nothing to export").
    expect(frame).toMatch(/database disk image is malformed/);
    expect(frame).not.toMatch(/no transcript/i);
  });
});

describe("ExportOverlay preview race (Sentinel #1694 §3)", () => {
  it("drops a stale earlier render that resolves after a newer one (latest wins)", async () => {
    const slowA = deferred<string | null>(); // markdown (request A, slow)
    const fastB = deferred<string | null>(); // json (request B, fast)
    const renderFn = vi.fn((_panel: string, fmt: string) =>
      fmt === "markdown" ? slowA.promise : fastB.promise,
    );
    const { stdin, lastFrame } = renderScreen({
      export: { render: renderFn, writeFile: vi.fn(async () => undefined) },
    });

    await flush();
    // Dispatch request A (markdown), move the cursor to json, dispatch request B
    // (json) — both fired from the pick phase before either settles.
    stdin.write(ENTER);
    stdin.write("j");
    stdin.write(ENTER);
    await flush();

    expect(renderFn).toHaveBeenCalledWith("Acme", "markdown", undefined);
    expect(renderFn).toHaveBeenCalledWith("Acme", "json", undefined);

    // The newer request B resolves first and is published.
    fastB.resolve("PREVIEW-JSON-NEWER");
    await flush();
    expect(lastFrame() ?? "").toContain("PREVIEW-JSON-NEWER");

    // The stale request A resolves AFTER B — it must be dropped, never published.
    slowA.resolve("PREVIEW-MARKDOWN-STALE");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("PREVIEW-JSON-NEWER");
    expect(frame).not.toContain("PREVIEW-MARKDOWN-STALE");
    // The format label must also stay pinned to the newer request, proving the
    // stale resolution did not re-publish overlay state.
    expect(frame).toMatch(/Format:\s*JSON/);
    expect(frame).not.toMatch(/Format:\s*Markdown/);
  });

  it("drops a stale render that REJECTS after a newer one resolved (no error overwrite)", async () => {
    const slowA = deferred<string | null>(); // markdown (stale, rejects late)
    const fastB = deferred<string | null>(); // json (newer, resolves)
    const renderFn = vi.fn((_panel: string, fmt: string) =>
      fmt === "markdown" ? slowA.promise : fastB.promise,
    );
    const { stdin, lastFrame } = renderScreen({
      export: { render: renderFn, writeFile: vi.fn(async () => undefined) },
    });

    await flush();
    stdin.write(ENTER);
    stdin.write("j");
    stdin.write(ENTER);
    await flush();

    fastB.resolve("PREVIEW-JSON-NEWER");
    await flush();
    expect(lastFrame() ?? "").toContain("PREVIEW-JSON-NEWER");

    // A late REJECTION from the superseded request must not clobber the live
    // preview with a stale error state.
    slowA.reject(new Error("stale markdown failure"));
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("PREVIEW-JSON-NEWER");
    expect(frame).not.toMatch(/stale markdown failure/);
  });

  it("still publishes a single, non-raced preview (the guard never drops the latest)", async () => {
    const only = deferred<string | null>();
    const renderFn = vi.fn(() => only.promise);
    const { stdin, lastFrame } = renderScreen({
      export: { render: renderFn, writeFile: vi.fn(async () => undefined) },
    });

    await flush();
    stdin.write(ENTER);
    await flush();
    only.resolve("SOLO-PREVIEW");
    await flush();

    expect(lastFrame() ?? "").toContain("SOLO-PREVIEW");
  });
});

describe("ExportOverlay adversarial panel names (Sentinel #1694 §4)", () => {
  const traversalCases: readonly { readonly label: string; readonly name: string }[] = [
    { label: "relative traversal", name: "../../etc/passwd" },
    { label: "absolute path", name: "/etc/passwd" },
    { label: "windows traversal", name: "..\\..\\Windows\\System32\\cmd" },
    { label: "obfuscated dot-slash", name: "....//....//secret" },
    { label: "bidi + control traversal", name: "\u202e../\u0007etc/passwd" },
  ];

  for (const { label, name } of traversalCases) {
    it(`derives an in-root, separator-free export path for a ${label} panel name`, async () => {
      const writeFile = vi.fn(async () => undefined);
      const { stdin } = renderScreen({
        export: { render: async () => "DOC BODY", writeFile },
        panelName: name,
      });

      await flush();
      stdin.write(ENTER); // preview
      await flush();
      stdin.write(ENTER); // write to the derived path
      await flush();

      expect(writeFile).toHaveBeenCalledOnce();
      const writtenPath = writeFile.mock.calls[0]?.[0] ?? "";

      // The derived filename carries no path separators and cannot walk up out
      // of the export directory.
      expect(writtenPath).not.toMatch(/[\\/]/);
      expect(writtenPath).not.toContain("..");
      expect(writtenPath).toMatch(/^[a-z0-9][a-z0-9-]*-markdown\.md$/);

      // Resolving the derived path against any export root stays inside it.
      const root = path.resolve("/export/root");
      const resolved = path.resolve(root, writtenPath);
      expect(resolved.startsWith(root + path.sep)).toBe(true);
    });
  }

  it("renders the header single-line and control-free for a control/bidi/zero-width name", async () => {
    const nasty = "A\u0009B\u0007C\u202eD\u2066E\u200bF\r\nG\u2028H\u0000I\u009bJ\u007fK\u2029L";
    // eslint-disable-next-line no-control-regex -- asserting the display carries no control/bidi bytes
    const control = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

    const benign = renderScreen({
      export: { render: async () => "DOC BODY", writeFile: vi.fn(async () => undefined) },
      panelName: "Plain Panel",
    });
    await flush();
    const benignLines = (benign.lastFrame() ?? "").split("\n").length;

    const { lastFrame } = renderScreen({
      export: { render: async () => "DOC BODY", writeFile: vi.fn(async () => undefined) },
      panelName: nasty,
    });
    await flush();

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    // The untrusted panel name is displayed only on the header line. Under
    // NO_COLOR the header carries no ANSI of its own, so any control / bidi /
    // line-separator byte here would be attacker-injected. (Picker rows use
    // Ink's `inverse` SGR legitimately, so they are excluded.)
    const headerLine = lines.find((line) => line.includes("Export")) ?? "";
    expect(headerLine).not.toMatch(control);
    // The untrusted name forged no extra rows: its visible glyphs stay on the
    // single header line (CR/LF/LS/PS collapsed, not row-splitting).
    expect(lines.length).toBe(benignLines);
    expect(headerLine).toContain("A");
    expect(headerLine).toContain("L");
  });
});

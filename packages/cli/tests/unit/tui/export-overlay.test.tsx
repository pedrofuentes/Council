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

import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import type { SettingsFieldState } from "../../../src/tui/adapters/config-settings.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import {
  InputCaptureProvider,
  useInputCapture,
} from "../../../src/tui/components/InputCaptureProvider.js";
import { SettingsScreen } from "../../../src/tui/screens/SettingsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const fields: readonly SettingsFieldState[] = [
  {
    path: "defaults.model",
    section: "Defaults\u001B[31m",
    label: "Default\nmodel",
    kind: "string",
    value: "gpt-4o\u001B[32m",
  },
  {
    path: "defaults.maxRounds",
    section: "Defaults",
    label: "Max rounds",
    kind: "number",
    value: "3",
    integer: true,
    min: 1,
    max: 20,
  },
  {
    path: "telemetry.enabled",
    section: "Telemetry",
    label: "Telemetry enabled",
    kind: "boolean",
    value: "false",
  },
  {
    path: "telemetry.mode",
    section: "Telemetry",
    label: "Telemetry mode",
    kind: "enum",
    value: "ask",
    options: ["ask", "auto"],
  },
];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const waitForEscape = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 120));
  await flush();
};
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const withSettings = (load: () => Promise<readonly SettingsFieldState[]>): TuiDataSources =>
  ({
    panels: { loadList: async () => [], loadDetail: async () => undefined },
    settings: { load, save: async () => undefined },
  }) as TuiDataSources;

function CaptureProbe(): React.ReactElement {
  const { captured } = useInputCapture();
  return <Text>CAPTURED {captured ? "yes" : "no"}</Text>;
}

function renderSettings(
  load: () => Promise<readonly SettingsFieldState[]>,
): ReturnType<typeof render> {
  return render(
    <InputCaptureProvider>
      <DataProvider value={withSettings(load)}>
        <MemoryRouter initialEntries={["/settings"]}>
          <Routes>
            <Route
              path="/settings"
              element={
                <>
                  <SettingsScreen theme={theme} />
                  <CaptureProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

const highlightedRow = (frame: string): string | undefined =>
  frame
    .split("\n")
    .find((line) => line.includes("\u001B[7m"))
    ?.replace(ansiPattern, "");

describe("SettingsScreen", () => {
  it("renders section headers, sanitized field rows, legend, and captures input", async () => {
    const { lastFrame, unmount } = renderSettings(async () => fields);

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Defaults");
    expect(frame).toContain("  Default model: gpt-4o");
    expect(frame).toContain("  Max rounds: 3");
    expect(frame).toContain("Telemetry");
    expect(frame).toContain("  Telemetry enabled: false");
    expect(frame).toContain("↑↓ move · Esc back");
    expect(frame).toContain("CAPTURED yes");
    expect(frame).not.toContain("\u001B[31m");
    expect(frame).not.toContain("\u001B[32m");
    expect(highlightedRow(frame)).toContain("  Default model: gpt-4o");
    unmount();
  });

  it("moves the highlighted field down with arrow down, j, and Tab, then clamps at the end", async () => {
    const { stdin, lastFrame, unmount } = renderSettings(async () => fields);
    await flush();

    stdin.write("\u001B[B");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Max rounds: 3");

    stdin.write("j");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Telemetry enabled: false");

    stdin.write("\t");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Telemetry mode: ask");

    stdin.write("\t");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Telemetry mode: ask");
    unmount();
  });

  it("moves the highlighted field up with arrow up, k, and Shift+Tab, then clamps at the start", async () => {
    const { stdin, lastFrame, unmount } = renderSettings(async () => fields);
    await flush();

    stdin.write("\u001B[B");
    await flush();
    stdin.write("\u001B[B");
    await flush();
    stdin.write("\u001B[B");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Telemetry mode: ask");

    stdin.write("\u001B[A");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Telemetry enabled: false");

    stdin.write("k");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Max rounds: 3");

    stdin.write("\u001B[Z");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Default model: gpt-4o");

    stdin.write("\u001B[Z");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("  Default model: gpt-4o");
    unmount();
  });

  it("keeps cursor handlers as no-ops when no fields are loaded", async () => {
    const { stdin, lastFrame, unmount } = renderSettings(async () => []);
    await flush();

    stdin.write("\u001B[B");
    await flush();
    stdin.write("j");
    await flush();
    stdin.write("\t");
    await flush();
    stdin.write("\u001B[A");
    await flush();
    stdin.write("k");
    await flush();
    stdin.write("\u001B[Z");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("↑↓ move · Esc back");
    expect(frame).not.toContain("\u001B[7m");
    unmount();
  });

  it("navigates back on Escape", async () => {
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={withSettings(async () => fields)}>
          <MemoryRouter initialEntries={["/", "/settings"]} initialIndex={1}>
            <Routes>
              <Route path="/" element={<Text>HOME</Text>} />
              <Route path="/settings" element={<SettingsScreen theme={theme} />} />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );

    await flush();
    stdin.write("\u001B");
    await waitForEscape();

    expect(lastFrame()).toContain("HOME");
    unmount();
  });

  it("shows loading and error states", async () => {
    const loading = renderSettings(
      async () => new Promise<readonly SettingsFieldState[]>(() => undefined),
    );
    await flush();
    expect(loading.lastFrame()).toContain("Loading settings…");
    loading.unmount();

    const error = renderSettings(async () => {
      throw new Error("boom");
    });
    await flush();
    expect(error.lastFrame()).toContain("Failed to load settings");
    error.unmount();
  });
});

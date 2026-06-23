import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { HomeData } from "../../../src/tui/adapters/home-data.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import {
  InputCaptureProvider,
  useInputCapture,
} from "../../../src/tui/components/InputCaptureProvider.js";
import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import { ROUTES } from "../../../src/tui/router/routes.js";

const homeData: HomeData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] };
const dataSources: TuiDataSources = {
  panels: { loadList: async () => [], loadDetail: async () => undefined },
};

async function flush(stdin?: { write: (s: string) => void }, input?: string): Promise<void> {
  stdin?.write(input ?? "");
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

function CaptureValue(): React.ReactElement {
  const { captured } = useInputCapture();
  return <Text>{String(captured)}</Text>;
}

function CaptureOnMount(): React.ReactElement {
  const { setCaptured } = useInputCapture();
  React.useEffect(() => {
    setCaptured(true);
  }, [setCaptured]);
  return <Text>capture enabled</Text>;
}

describe("InputCaptureProvider", () => {
  it("returns a safe default outside a provider and plumbs provided capture state", async () => {
    const bare = render(<CaptureValue />);
    await flush();
    expect(bare.lastFrame()).toBe("false");
    bare.unmount();

    const provided = render(
      <InputCaptureProvider>
        <CaptureOnMount />
        <CaptureValue />
      </InputCaptureProvider>,
    );
    await flush();
    expect(provided.lastFrame()).toContain("true");
    provided.unmount();
  });

  it("leaves AppRouter global keys active by default", async () => {
    const { stdin, lastFrame, unmount } = render(
      <DataProvider value={dataSources}>
        <CouncilTUI homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
      </DataProvider>,
    );
    await flush();
    const initial = lastFrame() ?? "";
    expect(initial).toContain("Panels");

    await flush(stdin, "\\");
    const toggled = lastFrame() ?? "";
    expect(toggled).not.toContain("Panels");
    expect(toggled).not.toBe(initial);
    unmount();
  });

  it("gates AppRouter global keys while input is captured", async () => {
    const { stdin, lastFrame, unmount } = render(
      <DataProvider value={dataSources}>
        <InputCaptureProvider>
          <CaptureOnMount />
          <MemoryRouter initialEntries={[ROUTES.home]}>
            <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
          </MemoryRouter>
        </InputCaptureProvider>
      </DataProvider>,
    );
    await flush();
    const initial = lastFrame() ?? "";
    expect(initial).toContain("Panels");

    await flush(stdin, "\\");
    const afterToggle = lastFrame() ?? "";
    expect(afterToggle).toBe(initial);
    expect(afterToggle).toContain("Panels");

    await flush(stdin, "?");
    const afterHelp = lastFrame() ?? "";
    expect(afterHelp).toBe(initial);
    expect(afterHelp.toLowerCase()).not.toContain("keyboard shortcuts");
    unmount();
  });
});

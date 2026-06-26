// packages/cli/tests/unit/tui/home-screen.test.tsx
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import { HomeScreen } from "../../../src/tui/screens/HomeScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const emptyData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] } as const;
const populatedData = {
  counts: { sessions: 12, experts: 9, panels: 5 },
  recent: [{ id: "s1", title: "Microservices migration", when: "2d", status: "convened" as const }],
} as const;

describe("HomeScreen", () => {
  it("lists recent sessions, counts, and quick actions", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={populatedData} />
      </MemoryRouter>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Microservices migration");
    expect(frame).toContain("12 sessions");
    expect(frame).toContain("Convene");
    unmount();
  });

  it("shows an empty-state CTA when there is nothing yet", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={emptyData} />
      </MemoryRouter>,
    );
    expect((lastFrame() ?? "").toLowerCase()).toContain("start your first");
    unmount();
  });

  it("sanitizes session titles", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen
          theme={theme}
          data={{
            counts: { sessions: 1, experts: 0, panels: 0 },
            recent: [{ id: "s1", title: "evil\u0007\u001b[31m", when: "1d", status: "convened" }],
          }}
        />
      </MemoryRouter>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    unmount();
  });

  it("shows ✓ for concluded sessions and • for convened", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen
          theme={theme}
          data={{
            counts: { sessions: 2, experts: 0, panels: 0 },
            recent: [
              { id: "s1", title: "Concluded session", when: "3d", status: "concluded" },
              { id: "s2", title: "Active session", when: "1d", status: "convened" },
            ],
          }}
        />
      </MemoryRouter>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("•");
    unmount();
  });
});

describe("HomeScreen — quick-action keys", () => {
  it("c navigates to /panels/compose in the populated state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("c");
    await flush();
    expect(lastFrame()).toContain("COMPOSE PANEL");
    unmount();
  });

  it("c navigates to /panels/compose in the empty state (fixes dead [c] button)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={emptyData} isActive />} />
          <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("c");
    await flush();
    expect(lastFrame()).toContain("COMPOSE PANEL");
    unmount();
  });

  it("e navigates to /experts/new in the populated state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/experts/new" element={<Text>NEW EXPERT</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("e");
    await flush();
    expect(lastFrame()).toContain("NEW EXPERT");
    unmount();
  });

  it("e navigates to /experts/new in the empty state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={emptyData} isActive />} />
          <Route path="/experts/new" element={<Text>NEW EXPERT</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("e");
    await flush();
    expect(lastFrame()).toContain("NEW EXPERT");
    unmount();
  });

  it("p navigates to /panels/new in the populated state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("NEW PANEL");
    unmount();
  });

  it("p navigates to /panels/new in the empty state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={emptyData} isActive />} />
          <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("NEW PANEL");
    unmount();
  });

  it(", navigates to /settings in the populated state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/settings" element={<Text>SETTINGS</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write(",");
    await flush();
    expect(lastFrame()).toContain("SETTINGS");
    unmount();
  });

  it(", navigates to /settings in the empty state", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={emptyData} isActive />} />
          <Route path="/settings" element={<Text>SETTINGS</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write(",");
    await flush();
    expect(lastFrame()).toContain("SETTINGS");
    unmount();
  });

  it("keys do NOT navigate when isActive is false", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<HomeScreen theme={theme} data={populatedData} isActive={false} />}
          />
          <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
          <Route path="/experts/new" element={<Text>NEW EXPERT</Text>} />
          <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
          <Route path="/settings" element={<Text>SETTINGS</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    for (const key of ["c", "e", "p", ","]) {
      stdin.write(key);
      await flush();
    }
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("COMPOSE PANEL");
    expect(frame).not.toContain("NEW EXPERT");
    expect(frame).not.toContain("NEW PANEL");
    expect(frame).not.toContain("SETTINGS");
    unmount();
  });
});

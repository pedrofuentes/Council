// packages/cli/tests/unit/tui/home-screen.test.tsx
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";

import { HomeScreen } from "../../../src/tui/screens/HomeScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

// Renders the raw matched pathname so tests can assert exactly what reached
// the router — react-router's useParams() would decode a path segment back,
// masking whether the value was encoded before navigation.
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return <Text>{`ROUTE:${location.pathname}`}</Text>;
}

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

  it("shows an empty-state launchpad with a selectable ▸ Convene a debate action", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={emptyData} />
      </MemoryRouter>,
    );
    expect(lastFrame() ?? "").toContain("▸ Convene a debate");
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

  it("cursor keys and Enter are inert (in addition to quick-action keys) when isActive is false", async () => {
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
          <Route path="/sessions/:id" element={<Text>SESSION DETAIL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    const before = lastFrame() ?? "";
    for (const key of ["c", "e", "p", ",", "j", "k", "\u001b[B", "\u001b[A", "\r"]) {
      stdin.write(key);
      await flush();
    }
    const frame = lastFrame() ?? "";
    // No navigation occurred for any key — quick-action letters, cursor
    // movement (j/k/arrows), or Enter.
    expect(frame).not.toContain("COMPOSE PANEL");
    expect(frame).not.toContain("NEW EXPERT");
    expect(frame).not.toContain("NEW PANEL");
    expect(frame).not.toContain("SETTINGS");
    expect(frame).not.toContain("SESSION DETAIL");
    // The selection cursor did not move either — the frame is byte-identical
    // to before any key was pressed.
    expect(frame).toBe(before);
    unmount();
  });
});

describe("HomeScreen — launchpad rendering", () => {
  it("renders a › selection affordance on the focused row", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={populatedData} isActive />
      </MemoryRouter>,
    );
    expect(lastFrame() ?? "").toContain("›");
    unmount();
  });

  it("↓ arrow moves the cursor (frame changes)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={populatedData} isActive />
      </MemoryRouter>,
    );
    await flush();
    const before = lastFrame() ?? "";
    stdin.write("\u001b[B");
    await flush();
    expect(lastFrame() ?? "").not.toBe(before);
    unmount();
  });

  it("↑ arrow moves the cursor back up (frame differs from mid-state)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={populatedData} isActive />
      </MemoryRouter>,
    );
    await flush();
    stdin.write("\u001b[B");
    await flush();
    const frameMid = lastFrame() ?? "";
    stdin.write("\u001b[A");
    await flush();
    expect(lastFrame() ?? "").not.toBe(frameMid);
    unmount();
  });

  it("j / k keys move the cursor", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={populatedData} isActive />
      </MemoryRouter>,
    );
    await flush();
    const before = lastFrame() ?? "";
    stdin.write("j");
    await flush();
    const afterJ = lastFrame() ?? "";
    expect(afterJ).not.toBe(before);
    stdin.write("k");
    await flush();
    expect(lastFrame() ?? "").toBe(before);
    unmount();
  });
});

describe("HomeScreen — launchpad Enter navigation", () => {
  it("Enter on row 0 (▸ Convene a debate) navigates to /panels/compose", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("COMPOSE PANEL");
    unmount();
  });

  it("Enter on row 1 (New expert) navigates to /experts/new", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/experts/new" element={<Text>NEW EXPERT</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("\u001b[B");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("NEW EXPERT");
    unmount();
  });

  it("Enter on row 2 (New panel) navigates to /panels/new", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/panels/new" element={<Text>NEW PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("\u001b[B");
    await flush();
    stdin.write("\u001b[B");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("NEW PANEL");
    unmount();
  });

  it("Enter on row 3 (Settings) navigates to /settings", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/settings" element={<Text>SETTINGS</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    for (let i = 0; i < 3; i++) {
      stdin.write("\u001b[B");
      await flush();
    }
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("SETTINGS");
    unmount();
  });

  it("Enter on recent session row (index 4) navigates to /sessions/:id", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={populatedData} isActive />} />
          <Route path="/sessions/:id" element={<Text>SESSION DETAIL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    for (let i = 0; i < 4; i++) {
      stdin.write("\u001b[B");
      await flush();
    }
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("SESSION DETAIL");
    unmount();
  });

  it("encodeURIComponent-encodes an unsafe recent-session id before building the route (regression)", async () => {
    // "/", "?", "=", and "#" are unsafe inside a single /sessions/:id path segment:
    // unescaped they would split the path, start a query string, or start a fragment.
    const unsafeId = "s/1?x=y#z";
    const data = {
      counts: { sessions: 1, experts: 0, panels: 0 },
      recent: [{ id: unsafeId, title: "Unsafe id session", when: "1d", status: "convened" as const }],
    };
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={data} isActive />} />
          <Route path="/sessions/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    for (let i = 0; i < 4; i++) {
      stdin.write("\u001b[B");
      await flush();
    }
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`ROUTE:/sessions/${encodeURIComponent(unsafeId)}`);
    // The raw, unescaped id must never reach the route.
    expect(frame).not.toContain(`ROUTE:/sessions/${unsafeId}`);
    unmount();
  });
});

describe("HomeScreen — launchpad empty state actions", () => {
  it("Enter on first empty-state item navigates to /panels/compose", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={emptyData} isActive />} />
          <Route path="/panels/compose" element={<Text>COMPOSE PANEL</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("COMPOSE PANEL");
    unmount();
  });

  it("↓ then Enter on empty-state item 1 navigates to /experts/new", async () => {
    const { stdin, lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomeScreen theme={theme} data={emptyData} isActive />} />
          <Route path="/experts/new" element={<Text>NEW EXPERT</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    stdin.write("\u001b[B");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("NEW EXPERT");
    unmount();
  });

  it("empty-state selection affordance › is rendered", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <HomeScreen theme={theme} data={emptyData} isActive />
      </MemoryRouter>,
    );
    expect(lastFrame() ?? "").toContain("›");
    unmount();
  });
});

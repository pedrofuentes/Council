import React, { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe("vendor library smoke (Ink 7 / React 19)", () => {
  it("ink-text-input renders and reports typed changes", async () => {
    let value = "";
    function Harness(): React.ReactElement {
      const [v, setV] = useState("");
      return (
        <TextInput
          value={v}
          onChange={(next) => {
            value = next;
            setV(next);
          }}
        />
      );
    }
    const { stdin, unmount } = render(<Harness />);
    await flush();
    stdin.write("hello");
    await flush();
    expect(value).toBe("hello");
    unmount();
  });

  it("ink-select-input renders items and selects on Enter", async () => {
    let selectedLabel = "";
    const items = [
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
    ];
    const { stdin, lastFrame, unmount } = render(
      <SelectInput items={items} onSelect={(item) => { selectedLabel = item.label; }} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("Alpha");
    stdin.write("\r");
    await flush();
    expect(selectedLabel).toBe("Alpha");
    unmount();
  });

  it("react-router MemoryRouter renders the initial route", () => {
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <Routes>
          <Route path="/home" element={<Text>home-route</Text>} />
          <Route path="/other" element={<Text>other-route</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(lastFrame() ?? "").toContain("home-route");
    unmount();
  });

  it("react-router useNavigate switches the active route", async () => {
    function Nav(): React.ReactElement {
      const navigate = useNavigate();
      useEffect(() => {
        navigate("/other");
      }, [navigate]);
      return <Text>navigating</Text>;
    }
    const { lastFrame, unmount } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <Routes>
          <Route path="/home" element={<Nav />} />
          <Route path="/other" element={<Text>other-route</Text>} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("other-route");
    unmount();
  });
});

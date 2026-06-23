import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { MultiSelectList } from "../../../src/tui/components/lists/MultiSelectList.js";

const items = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

const flush = async (
  stdin: { write: (s: string) => void } | undefined,
  s: string,
): Promise<void> => {
  stdin?.write(s);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("MultiSelectList", () => {
  it("renders every item label with an unchecked marker", () => {
    const { lastFrame } = render(<MultiSelectList items={items} selected={[]} />);

    expect(lastFrame()).toContain("[ ] Alpha");
    expect(lastFrame()).toContain("[ ] Beta");
    expect(lastFrame()).toContain("[ ] Gamma");
  });

  it("renders pre-selected values with a checked marker", () => {
    const { lastFrame } = render(<MultiSelectList items={items} selected={["b"]} />);

    expect(lastFrame()).toContain("[ ] Alpha");
    expect(lastFrame()).toContain("[x] Beta");
    expect(lastFrame()).toContain("[ ] Gamma");
  });

  it("moves the cursor with j/down and k/up", async () => {
    const { stdin, lastFrame } = render(<MultiSelectList items={items} selected={[]} />);

    expect(lastFrame()).toContain("\u001b[7m[ ] Alpha");
    await flush(stdin, "j");
    expect(lastFrame()).toContain("\u001b[7m[ ] Beta");
    await flush(stdin, "\u001b[B");
    expect(lastFrame()).toContain("\u001b[7m[ ] Gamma");
    await flush(stdin, "k");
    expect(lastFrame()).toContain("\u001b[7m[ ] Beta");
    await flush(stdin, "\u001b[A");
    expect(lastFrame()).toContain("\u001b[7m[ ] Alpha");
  });

  it("toggles the highlighted item on Space and reports the next selection", async () => {
    const onChange = vi.fn();
    const selected = ["a"] as const;
    const { stdin } = render(
      <MultiSelectList items={items} selected={[]} isActive onChange={onChange} />,
    );

    await flush(stdin, " ");
    expect(onChange).toHaveBeenCalledWith(selected);

    const updated = render(
      <MultiSelectList items={items} selected={selected} isActive onChange={onChange} />,
    );
    expect(updated.lastFrame()).toContain("[x] Alpha");
  });

  it("removes the highlighted item on Space when it is already selected", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <MultiSelectList items={items} selected={["a"]} isActive onChange={onChange} />,
    );

    await flush(stdin, " ");

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("submits the current selected values on Enter", async () => {
    const onSubmit = vi.fn();
    const selected = ["b"] as const;
    const { stdin } = render(
      <MultiSelectList items={items} selected={selected} onSubmit={onSubmit} />,
    );

    await flush(stdin, "\r");

    expect(onSubmit).toHaveBeenCalledWith(selected);
  });

  it("ignores navigation, Space, and Enter when inactive", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <MultiSelectList
        items={items}
        selected={[]}
        isActive={false}
        onChange={onChange}
        onSubmit={onSubmit}
      />,
    );

    await flush(stdin, "j");
    await flush(stdin, " ");
    await flush(stdin, "\r");

    expect(lastFrame()).toContain("\u001b[7m[ ] Alpha");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sanitizes item labels before rendering", () => {
    const { lastFrame } = render(
      <MultiSelectList items={[{ value: "danger", label: "\u001b[31mX" }]} selected={[]} />,
    );

    expect(lastFrame()).toContain("X");
    expect(lastFrame()).not.toContain("\u001b[31m");
  });
});

import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { SelectableList } from "../../../src/tui/components/lists/SelectableList.js";

const flush = async (stdin: { write: (s: string) => void } | undefined, s: string): Promise<void> => {
  stdin?.write(s);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("SelectableList", () => {
  it("inverts the active row and moves the cursor", async () => {
    const { stdin, lastFrame } = render(<SelectableList items={["Alpha", "Beta", "Gamma"]} height={5} />);
    expect(lastFrame()).toContain("\u001b[7mAlpha");
    await flush(stdin, "j");
    expect(lastFrame()).toContain("\u001b[7mBeta");
  });

  it("activates the focused item on Enter with its index", async () => {
    const onActivate = vi.fn();
    const { stdin } = render(<SelectableList items={["Alpha", "Beta"]} onActivate={onActivate} />);
    await flush(stdin, "j");
    await flush(stdin, "\r");
    expect(onActivate).toHaveBeenCalledWith(1);
  });

  it("renders an empty list without crashing and ignores input", async () => {
    const onActivate = vi.fn();
    const { stdin, lastFrame } = render(<SelectableList items={[]} onActivate={onActivate} />);
    await flush(stdin, "\r");
    expect(onActivate).not.toHaveBeenCalled();
    expect(lastFrame()).toBeDefined();
  });
});

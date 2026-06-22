import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { MultilineInput } from "../../../src/tui/components/inputs/MultilineInput.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

function Harness(props: {
  readonly onSubmit?: (v: string) => void;
  readonly onValue?: (v: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  return (
    <MultilineInput
      value={value}
      onChange={(v) => {
        setValue(v);
        props.onValue?.(v);
      }}
      onSubmit={props.onSubmit}
    />
  );
}

describe("MultilineInput", () => {
  it("appends typed characters to the value", async () => {
    const { stdin, lastFrame, unmount } = render(<Harness />);
    await flush();
    stdin.write("hi");
    await flush();
    expect(lastFrame() ?? "").toContain("hi");
    unmount();
  });

  it("submits the current value on Enter", async () => {
    let submitted: string | undefined;
    const { stdin, unmount } = render(<Harness onSubmit={(v) => { submitted = v; }} />);
    await flush();
    stdin.write("ok");
    await flush();
    stdin.write("\r");
    await flush();
    expect(submitted).toBe("ok");
    unmount();
  });

  it("inserts a real newline on Ctrl+J without submitting", async () => {
    let submitted: string | undefined;
    let latest = "";
    const { stdin, unmount } = render(
      <Harness onSubmit={(v) => { submitted = v; }} onValue={(v) => { latest = v; }} />,
    );
    await flush();
    stdin.write("a");
    await flush();
    stdin.write("\n");
    await flush();
    stdin.write("b");
    await flush();
    expect(submitted).toBeUndefined();
    expect(latest).toBe("a\nb");
    unmount();
  });

  it("removes the last character on Backspace", async () => {
    let latest = "";
    const { stdin, unmount } = render(<Harness onValue={(v) => { latest = v; }} />);
    await flush();
    stdin.write("abc");
    await flush();
    stdin.write("\u007f");
    await flush();
    expect(latest).toBe("ab");
    unmount();
  });

  it("strips terminal control sequences from the rendered value", () => {
    const { lastFrame, unmount } = render(
      <MultilineInput value={"safe\u001b[31m\u0007text"} onChange={() => { /* noop */ }} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    expect(frame).toContain("safetext");
    unmount();
  });
});

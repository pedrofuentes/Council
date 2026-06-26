import { EventEmitter } from "node:events";
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import {
  useTerminalSize,
  type ResizableStdout,
} from "../../../src/tui/hooks/use-terminal-size.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

class FakeStdout extends EventEmitter implements ResizableStdout {
  public columns: number | undefined;
  public rows: number | undefined;

  constructor(columns: number | undefined, rows: number | undefined) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
}

function Harness(props: { readonly stdout: ResizableStdout }): React.ReactElement {
  const { columns, rows } = useTerminalSize({ stdout: props.stdout });
  return (
    <Text>
      dims:{columns}x{rows}
    </Text>
  );
}

describe("useTerminalSize", () => {
  it("reports the initial terminal dimensions", () => {
    const fake = new FakeStdout(120, 40);
    const { lastFrame, unmount } = render(<Harness stdout={fake} />);
    expect(lastFrame()).toContain("dims:120x40");
    unmount();
  });

  it("reflows when the terminal emits a resize", async () => {
    const fake = new FakeStdout(120, 40);
    const { lastFrame, unmount } = render(<Harness stdout={fake} />);
    expect(lastFrame()).toContain("dims:120x40");

    fake.columns = 80;
    fake.rows = 24;
    fake.emit("resize");
    await flush();

    expect(lastFrame()).toContain("dims:80x24");
    unmount();
  });

  it("removes the resize listener on unmount", () => {
    const fake = new FakeStdout(100, 30);
    const { unmount } = render(<Harness stdout={fake} />);
    expect(fake.listenerCount("resize")).toBe(1);
    unmount();
    expect(fake.listenerCount("resize")).toBe(0);
  });

  it("falls back to 80x24 when dimensions are undefined", () => {
    const fake = new FakeStdout(undefined, undefined);
    const { lastFrame, unmount } = render(<Harness stdout={fake} />);
    expect(lastFrame()).toContain("dims:80x24");
    unmount();
  });
});

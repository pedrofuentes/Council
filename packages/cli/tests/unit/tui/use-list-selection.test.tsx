import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it, vi } from "vitest";

import { useListSelection } from "../../../src/tui/hooks/use-list-selection.js";

function Harness(props: { count: number; onActivate?: (i: number) => void; isActive?: boolean }): React.ReactElement {
  const { cursor } = useListSelection({ count: props.count, onActivate: props.onActivate, isActive: props.isActive });
  return <Text>cursor={cursor}</Text>;
}

const flush = async (stdin: { write: (s: string) => void } | undefined, s: string): Promise<void> => {
  stdin?.write(s);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("useListSelection", () => {
  it("moves down with j and arrow, clamped at count-1", async () => {
    const { stdin, lastFrame } = render(<Harness count={3} />);
    await flush(stdin, "j");
    expect(lastFrame()).toContain("cursor=1");
    await flush(stdin, "\u001b[B");
    expect(lastFrame()).toContain("cursor=2");
    await flush(stdin, "j");
    expect(lastFrame()).toContain("cursor=2");
  });

  it("moves up with k, clamped at 0; g/G jump to ends", async () => {
    const { stdin, lastFrame } = render(<Harness count={3} />);
    await flush(stdin, "G");
    expect(lastFrame()).toContain("cursor=2");
    await flush(stdin, "k");
    expect(lastFrame()).toContain("cursor=1");
    await flush(stdin, "g");
    expect(lastFrame()).toContain("cursor=0");
    await flush(stdin, "k");
    expect(lastFrame()).toContain("cursor=0");
  });

  it("fires onActivate(cursor) on Enter", async () => {
    const onActivate = vi.fn();
    const { stdin } = render(<Harness count={3} onActivate={onActivate} />);
    await flush(stdin, "j");
    await flush(stdin, "\r");
    expect(onActivate).toHaveBeenCalledWith(1);
  });

  it("is inert when count===0 or isActive===false", async () => {
    const onActivate = vi.fn();
    const a = render(<Harness count={0} onActivate={onActivate} />);
    await flush(a.stdin, "j");
    await flush(a.stdin, "\r");
    expect(a.lastFrame()).toContain("cursor=0");
    expect(onActivate).not.toHaveBeenCalled();
    const b = render(<Harness count={3} onActivate={onActivate} isActive={false} />);
    await flush(b.stdin, "j");
    expect(b.lastFrame()).toContain("cursor=0");
  });
});

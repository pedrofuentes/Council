import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { useAsyncResource } from "../../../src/tui/hooks/use-async-resource.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

function Probe<T>(props: {
  readonly loader: () => Promise<T>;
  readonly render: (state: ReturnType<typeof useAsyncResource<T>>) => string;
}): React.ReactElement {
  const state = useAsyncResource(props.loader);
  return <Text>{props.render(state)}</Text>;
}

describe("useAsyncResource", () => {
  it("starts loading then resolves to loaded with data", async () => {
    const { lastFrame } = render(
      <Probe
        loader={async () => 42}
        render={(state) => (state.status === "loaded" ? `n=${state.data}` : state.status)}
      />,
    );
    expect(lastFrame()).toContain("loading");
    await flush();
    expect(lastFrame()).toContain("n=42");
  });

  it("captures an Error on rejection", async () => {
    const { lastFrame } = render(
      <Probe
        loader={async () => {
          throw new Error("boom");
        }}
        render={(state) => (state.status === "error" ? state.error.message : state.status)}
      />,
    );
    await flush();
    expect(lastFrame()).toContain("boom");
  });

  it("coerces a non-Error rejection into an Error", async () => {
    const { lastFrame } = render(
      <Probe
        loader={async () => {
          throw "oops";
        }}
        render={(state) => (state.status === "error" ? state.error.message : state.status)}
      />,
    );
    await flush();
    expect(lastFrame()).toContain("oops");
  });
  it("drops a stale resolution after the loader changes", async () => {
    let resolveStale: ((value: number) => void) | undefined;
    const stale = (): Promise<number> =>
      new Promise((resolve) => {
        resolveStale = resolve;
      });
    const fresh = (): Promise<number> => Promise.resolve(2);
    const renderState = (state: ReturnType<typeof useAsyncResource<number>>): string =>
      state.status === "loaded" ? `n=${state.data}` : state.status;

    const { rerender, lastFrame } = render(<Probe loader={stale} render={renderState} />);
    expect(lastFrame()).toContain("loading");

    // Switching loaders cancels the first effect (cleanup sets cancelled=true).
    rerender(<Probe loader={fresh} render={renderState} />);
    await flush();
    expect(lastFrame()).toContain("n=2");

    // The now-stale first loader resolving late must NOT overwrite the fresh state.
    resolveStale?.(1);
    await flush();
    expect(lastFrame()).toContain("n=2");
  });

  it("drops a stale rejection after the loader changes", async () => {
    let rejectStale: ((reason: unknown) => void) | undefined;
    const stale = (): Promise<number> =>
      new Promise((_, reject) => {
        rejectStale = reject;
      });
    const fresh = (): Promise<number> => Promise.resolve(5);
    const renderState = (state: ReturnType<typeof useAsyncResource<number>>): string => {
      if (state.status === "loaded") return `n=${state.data}`;
      if (state.status === "error") return `err=${state.error.message}`;
      return state.status;
    };

    const { rerender, lastFrame } = render(<Probe loader={stale} render={renderState} />);
    rerender(<Probe loader={fresh} render={renderState} />);
    await flush();
    expect(lastFrame()).toContain("n=5");

    // The now-stale first loader rejecting late must NOT surface an error.
    rejectStale?.(new Error("late"));
    await flush();
    expect(lastFrame()).toContain("n=5");
  });
});

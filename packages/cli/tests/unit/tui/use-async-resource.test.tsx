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
});

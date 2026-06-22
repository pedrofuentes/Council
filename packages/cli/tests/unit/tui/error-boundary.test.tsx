import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { ErrorBoundary } from "../../../src/tui/components/ErrorBoundary.js";

function Boom(): React.ReactElement {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("catches a child render error, calls onError, and shows the fallback", () => {
    let captured: Error | undefined;
    const { lastFrame, unmount } = render(
      <ErrorBoundary onError={(e) => { captured = e; }} fallback={<Text>recovered</Text>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(captured?.message).toBe("kaboom");
    expect(lastFrame() ?? "").toContain("recovered");
    unmount();
  });

  it("renders children normally when there is no error", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary onError={() => { /* no-op */ }}>
        <Text>healthy</Text>
      </ErrorBoundary>,
    );
    expect(lastFrame() ?? "").toContain("healthy");
    unmount();
  });

  it("shows a default fallback message when no fallback prop is given", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary onError={() => { /* no-op */ }}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(lastFrame() ?? "").toContain("unexpected error");
    unmount();
  });
});

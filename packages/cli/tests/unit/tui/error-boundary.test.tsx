import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { ErrorBoundary } from "../../../src/tui/components/ErrorBoundary.js";

function Boom({ message = "kaboom" }: { readonly message?: string }): React.ReactElement {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  it("catches a child render error, calls onError, and shows the fallback", () => {
    let captured: Error | undefined;
    const { lastFrame, unmount } = render(
      <ErrorBoundary
        onError={(e) => {
          captured = e;
        }}
        fallback={<Text>recovered</Text>}
      >
        <Boom />
      </ErrorBoundary>,
    );
    expect(captured?.message).toBe("kaboom");
    expect(lastFrame() ?? "").toContain("recovered");
    unmount();
  });

  it("renders children normally when there is no error", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary
        onError={() => {
          /* no-op */
        }}
      >
        <Text>healthy</Text>
      </ErrorBoundary>,
    );
    expect(lastFrame() ?? "").toContain("healthy");
    unmount();
  });

  it("shows a default fallback message when no fallback prop is given", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary
        onError={() => {
          /* no-op */
        }}
      >
        <Boom />
      </ErrorBoundary>,
    );
    expect(lastFrame() ?? "").toContain("unexpected error");
    unmount();
  });

  it("renders a tiered fallback: a headline plus the caught error-message detail", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary
        onError={() => {
          /* no-op */
        }}
      >
        <Boom message="disk exploded" />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    // Tier 1: the stable, i18n-ready headline.
    expect(frame).toContain("Council hit an unexpected error");
    // Tier 2: the secondary detail surfaces the caught message. The minimal
    // pre-existing fallback rendered only the headline, so this bites.
    expect(frame).toContain("disk exploded");
    unmount();
  });

  it("collapses and strips control characters in the error-message detail at the sink", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary
        onError={() => {
          /* no-op */
        }}
      >
        <Boom message={"boom\u0007\u001b[31m\nspoof\u2028end"} />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    // toSingleLineDisplay strips BEL/ANSI and collapses \n + U+2028 to single
    // spaces, so an untrusted error message can neither forge extra lines nor
    // smuggle terminal-control sequences into the fallback.
    expect(frame).toContain("boom spoof end");
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("\u2028");
    unmount();
  });

  it("summarizes the captured component stack (errorInfo) in the fallback", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary
        onError={() => {
          /* no-op */
        }}
      >
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    // componentDidCatch captures errorInfo.componentStack; the fallback surfaces
    // its first frame so the user sees *where* it broke (the throwing Boom).
    expect(frame).toContain("Boom");
    unmount();
  });
});

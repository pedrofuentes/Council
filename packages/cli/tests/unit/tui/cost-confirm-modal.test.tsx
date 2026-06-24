import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { CostConfirmModal } from "../../../src/tui/components/CostConfirmModal.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
};

describe("CostConfirmModal", () => {
  it("renders a sanitized cost confirmation line", () => {
    const { lastFrame } = render(
      <CostConfirmModal
        theme={theme}
        experts={2}
        rounds={3}
        estimatedPremiumRequests={6}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        isActive
      />,
    );

    expect(lastFrame()).toContain(
      "Run debate with 2 experts × 3 rounds (~6 premium requests)? [y/n]",
    );
    expect(lastFrame()).not.toContain("\u001B");
  });

  it("confirms with y or Enter and cancels with n", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <CostConfirmModal
        theme={theme}
        experts={1}
        rounds={2}
        estimatedPremiumRequests={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
        isActive
      />,
    );

    stdin.write("y");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("n");
    await flush();

    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores keys while inactive", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <CostConfirmModal
        theme={theme}
        experts={1}
        rounds={1}
        estimatedPremiumRequests={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
        isActive={false}
      />,
    );

    stdin.write("y");
    stdin.write("\r");
    stdin.write("n");
    await flush();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

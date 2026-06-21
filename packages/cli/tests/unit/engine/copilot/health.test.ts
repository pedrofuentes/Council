/**
 * Tests for the pure Copilot CLI-path health check.
 *
 * `checkCopilotCliPath` is deliberately side-effect-free: it takes the
 * already-resolved inputs (the `COPILOT_CLI_PATH` override, the path the
 * SDK-coupled resolver computed, and an existence predicate) and classifies
 * them. This keeps it unit-testable without importing `@github/copilot-sdk`
 * or touching the real filesystem, and lets `council doctor` surface
 * actionable remediation for the known Windows path-resolution failure.
 */
import * as os from "node:os";

import { describe, expect, it } from "vitest";

import {
  COPILOT_CLI_REMEDIATION,
  checkCopilotCliPath,
} from "../../../../src/engine/copilot/health.js";

const REAL_CLI_PATH = "/some/project/node_modules/@github/copilot/npm-loader.js";
const BOGUS_CLI_PATH = "/some/project/node_modules/@github/index.js";

describe("checkCopilotCliPath", () => {
  it("passes when the resolved CLI entry exists", () => {
    const result = checkCopilotCliPath({
      resolvedPath: REAL_CLI_PATH,
      exists: () => true,
    });

    expect(result.status).toBe("ok");
  });

  it("needs remediation when the CLI entry cannot be resolved", () => {
    const result = checkCopilotCliPath({
      resolvedPath: undefined,
      exists: () => true,
    });

    expect(result.status).toBe("needs-remediation");
    expect(result.detail).toContain("COPILOT_CLI_PATH");
    expect(result.detail).toContain("npm-loader.js");
  });

  it("needs remediation for the bogus @github/index.js path even if it exists", () => {
    const result = checkCopilotCliPath({
      resolvedPath: BOGUS_CLI_PATH,
      exists: () => true,
    });

    expect(result.status).toBe("needs-remediation");
    expect(result.detail).toContain("COPILOT_CLI_PATH");
  });

  it("needs remediation for the bogus Windows-style @github\\index.js path", () => {
    const result = checkCopilotCliPath({
      resolvedPath: "C:\\proj\\node_modules\\@github\\index.js",
      exists: () => true,
    });

    expect(result.status).toBe("needs-remediation");
  });

  it("needs remediation when the resolved entry does not exist on disk", () => {
    const result = checkCopilotCliPath({
      resolvedPath: REAL_CLI_PATH,
      exists: () => false,
    });

    expect(result.status).toBe("needs-remediation");
  });

  it("respects an explicit COPILOT_CLI_PATH override and does not flag remediation", () => {
    const result = checkCopilotCliPath({
      override: "/custom/copilot/entry.js",
      resolvedPath: undefined,
      exists: () => false,
    });

    expect(result.status).toBe("override");
    expect(result.detail).not.toContain("npm-loader.js");
  });

  it("respects the override even when the resolver returned the bogus path", () => {
    const result = checkCopilotCliPath({
      override: "/custom/copilot/entry.js",
      resolvedPath: BOGUS_CLI_PATH,
      exists: () => true,
    });

    expect(result.status).toBe("override");
  });

  it("treats a blank override as unset", () => {
    const result = checkCopilotCliPath({
      override: "   ",
      resolvedPath: undefined,
      exists: () => true,
    });

    expect(result.status).toBe("needs-remediation");
  });

  it("offers reinstalling as an alternative remediation", () => {
    expect(COPILOT_CLI_REMEDIATION.toLowerCase()).toContain("reinstall");
  });

  it("keeps remediation text generic (no home path or username)", () => {
    const home = os.homedir();
    const username = os.userInfo().username;

    expect(COPILOT_CLI_REMEDIATION).not.toContain(home);
    expect(COPILOT_CLI_REMEDIATION).not.toContain(`${username}`);
  });
});

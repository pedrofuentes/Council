/**
 * Tests for `src/cli/exit-codes.ts` — semantic exit code constants
 * and the mapping function from EngineErrorCode to exit code.
 *
 * RED at this commit: src/cli/exit-codes.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import {
  EXIT_SUCCESS,
  EXIT_USER_ERROR,
  EXIT_AUTH_ERROR,
  EXIT_NETWORK_ERROR,
  EXIT_INTERNAL_ERROR,
  exitCodeForEngineError,
} from "../../../src/cli/exit-codes.js";

describe("exit-codes constants", () => {
  it("EXIT_SUCCESS is 0", () => {
    expect(EXIT_SUCCESS).toBe(0);
  });

  it("EXIT_USER_ERROR is 1", () => {
    expect(EXIT_USER_ERROR).toBe(1);
  });

  it("EXIT_AUTH_ERROR is 2", () => {
    expect(EXIT_AUTH_ERROR).toBe(2);
  });

  it("EXIT_NETWORK_ERROR is 3", () => {
    expect(EXIT_NETWORK_ERROR).toBe(3);
  });

  it("EXIT_INTERNAL_ERROR is 4", () => {
    expect(EXIT_INTERNAL_ERROR).toBe(4);
  });
});

describe("exitCodeForEngineError", () => {
  it("maps NOT_AUTHENTICATED to EXIT_AUTH_ERROR (2)", () => {
    expect(exitCodeForEngineError("NOT_AUTHENTICATED")).toBe(2);
  });

  it("maps NETWORK to EXIT_NETWORK_ERROR (3)", () => {
    expect(exitCodeForEngineError("NETWORK")).toBe(3);
  });

  it("maps RATE_LIMITED to EXIT_NETWORK_ERROR (3)", () => {
    expect(exitCodeForEngineError("RATE_LIMITED")).toBe(3);
  });

  it("maps INTERNAL to EXIT_INTERNAL_ERROR (4)", () => {
    expect(exitCodeForEngineError("INTERNAL")).toBe(4);
  });

  it("maps PROVIDER_ERROR to EXIT_INTERNAL_ERROR (4)", () => {
    expect(exitCodeForEngineError("PROVIDER_ERROR")).toBe(4);
  });

  it("maps MODEL_UNAVAILABLE to EXIT_USER_ERROR (1)", () => {
    expect(exitCodeForEngineError("MODEL_UNAVAILABLE")).toBe(1);
  });

  it("maps CONTEXT_OVERFLOW to EXIT_USER_ERROR (1)", () => {
    expect(exitCodeForEngineError("CONTEXT_OVERFLOW")).toBe(1);
  });

  it("maps ABORTED to EXIT_SUCCESS (0)", () => {
    expect(exitCodeForEngineError("ABORTED")).toBe(0);
  });

  it("maps undefined code to EXIT_INTERNAL_ERROR (4)", () => {
    expect(exitCodeForEngineError(undefined)).toBe(4);
  });
});

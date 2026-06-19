/**
 * Semantic exit code constants for the Council CLI.
 *
 * Scripts checking `!= 0` continue to work — all error codes are non-zero
 * except ABORTED (which is a clean cancellation, not an error).
 */
import type { EngineErrorCode } from "../engine/index.js";

export const EXIT_SUCCESS = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_AUTH_ERROR = 2;
export const EXIT_NETWORK_ERROR = 3;
export const EXIT_INTERNAL_ERROR = 4;

/**
 * Map an `EngineErrorCode` (or undefined) to a semantic CLI exit code.
 */
export function exitCodeForEngineError(code: EngineErrorCode | string | undefined): number {
  switch (code) {
    case "ABORTED":
      return EXIT_SUCCESS;
    case "NOT_AUTHENTICATED":
      return EXIT_AUTH_ERROR;
    case "NETWORK":
    case "RATE_LIMITED":
      return EXIT_NETWORK_ERROR;
    case "INTERNAL":
    case "PROVIDER_ERROR":
      return EXIT_INTERNAL_ERROR;
    case "MODEL_UNAVAILABLE":
    case "CONTEXT_OVERFLOW":
      return EXIT_USER_ERROR;
    default:
      return EXIT_INTERNAL_ERROR;
  }
}

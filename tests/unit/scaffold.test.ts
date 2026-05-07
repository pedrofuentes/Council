/**
 * Smoke test for the scaffolded project.
 *
 * Real test suites land with each Phase 1 module (engine, expert, debate, etc.).
 * This single test exists so `pnpm test` succeeds during scaffolding.
 */
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("project is configured for Node 20+ ESM", () => {
    expect(process.version.startsWith("v")).toBe(true);
    const versionParts = process.version.slice(1).split(".");
    const majorRaw = versionParts[0];
    expect(majorRaw).toBeDefined();
    const major = Number.parseInt(majorRaw ?? "0", 10);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});

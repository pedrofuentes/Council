/**
 * Smoke test for the scaffolded CLI entry.
 *
 * Imports `buildProgram` from src/bin/council.ts and asserts the program
 * is wired up correctly. This test will fail if any of the scaffolding
 * (tsconfig, package.json#version, or the Commander wiring) is reverted.
 */
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { buildProgram } from "../../src/bin/council.js";

describe("buildProgram", () => {
  it("returns a Commander program named 'council'", () => {
    const program = buildProgram();
    expect(program.name()).toBe("council");
  });

  it("reports the version from package.json", () => {
    const program = buildProgram();
    expect(program.version()).toBe(packageJson.version);
  });

  it("has a description matching the project tagline", () => {
    const program = buildProgram();
    expect(program.description()).toMatch(/expert panels/i);
  });
});

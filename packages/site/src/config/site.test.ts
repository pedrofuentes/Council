import { describe, expect, it } from "vitest";

import { basePath, siteUrl, withBase } from "./site";

describe("site config", () => {
  it("exposes the GitHub Pages origin as the site URL", () => {
    expect(siteUrl).toBe("https://pedrofuent.es");
  });

  it("exposes the project base path", () => {
    expect(basePath).toBe("/Council/");
  });

  describe("withBase", () => {
    it("returns the base path for the site root", () => {
      expect(withBase("/")).toBe("/Council/");
      expect(withBase("")).toBe("/Council/");
    });

    it("prefixes the base path to a route and preserves /Council/", () => {
      expect(withBase("/docs")).toBe("/Council/docs");
      expect(withBase("/docs/")).toBe("/Council/docs/");
      expect(withBase("/docs")).toContain("/Council/");
    });

    it("normalizes routes that omit a leading slash", () => {
      expect(withBase("docs")).toBe("/Council/docs");
    });
  });
});

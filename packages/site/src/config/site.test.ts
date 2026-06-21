import { describe, expect, it } from "vitest";

import {
  absoluteUrl,
  basePath,
  buildSoftwareApplicationLd,
  npmUrl,
  siteUrl,
  socialImagePath,
  socialImageUrl,
  withBase,
} from "./site";

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

describe("SEO + social discoverability config", () => {
  describe("absoluteUrl", () => {
    it("builds an absolute URL for the site root", () => {
      expect(absoluteUrl("/")).toBe("https://pedrofuentes.github.io/Council/");
    });

    it("builds an absolute URL for a nested asset path", () => {
      expect(absoluteUrl("/og/council-og.png")).toBe(
        "https://pedrofuentes.github.io/Council/og/council-og.png",
      );
    });

    it("normalizes paths that omit a leading slash", () => {
      expect(absoluteUrl("robots.txt")).toBe("https://pedrofuentes.github.io/Council/robots.txt");
    });
  });

  describe("social preview metadata", () => {
    it("points the social image at the committed PNG asset", () => {
      expect(socialImagePath).toBe("/og/council-og.png");
    });

    it("exposes the social image as an absolute URL", () => {
      expect(socialImageUrl).toBe("https://pedrofuentes.github.io/Council/og/council-og.png");
      expect(socialImageUrl.startsWith("https://")).toBe(true);
    });
  });

  describe("buildSoftwareApplicationLd", () => {
    const ld = buildSoftwareApplicationLd();

    it("declares the schema.org SoftwareApplication type", () => {
      expect(ld["@context"]).toBe("https://schema.org");
      expect(ld["@type"]).toBe("SoftwareApplication");
    });

    it("describes Council as a developer application with absolute links", () => {
      expect(ld.name).toBe("Council");
      expect(ld.applicationCategory).toBe("DeveloperApplication");
      expect(ld.url).toBe("https://pedrofuentes.github.io/Council/");
      expect(ld.image).toBe(socialImageUrl);
      expect(ld.codeRepository).toBe("https://github.com/pedrofuentes/Council");
      expect(ld.downloadUrl).toBe(npmUrl);
      expect(ld.description.length).toBeGreaterThan(0);
    });

    it("omits unverifiable rating or review claims", () => {
      expect(ld).not.toHaveProperty("aggregateRating");
      expect(ld).not.toHaveProperty("ratingValue");
      expect(ld).not.toHaveProperty("reviewCount");
    });
  });
});

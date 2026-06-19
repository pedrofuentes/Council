/**
 * Tests for `deriveFilenameFromUrl` helper used by `council expert train --url`.
 *
 * Roadmap T8: URL-to-filename derivation must handle path-less URLs
 * (e.g. https://example.com) by deriving a sensible filename from the host
 * instead of erroring.
 */
import { describe, expect, it } from "vitest";

import { deriveFilenameFromUrl } from "../../../../src/cli/commands/expert.js";

describe("deriveFilenameFromUrl", () => {
  describe("path-less URLs (T8 fix)", () => {
    it("derives filename from host for https://example.com", () => {
      const result = deriveFilenameFromUrl("https://example.com");
      expect(result).toBe("example.com.html");
    });

    it("derives filename from host for https://example.com/", () => {
      const result = deriveFilenameFromUrl("https://example.com/");
      expect(result).toBe("example.com.html");
    });

    it("derives filename from host for http://api.service.org", () => {
      const result = deriveFilenameFromUrl("http://api.service.org");
      expect(result).toBe("api.service.org.html");
    });

    it("derives filename from host for https://localhost:8080", () => {
      const result = deriveFilenameFromUrl("https://localhost:8080");
      expect(result).toBe("localhost.html");
    });
  });

  describe("existing behavior: path-based URLs", () => {
    it("extracts filename from simple path", () => {
      const result = deriveFilenameFromUrl("https://example.com/document.pdf");
      expect(result).toBe("document.pdf");
    });

    it("extracts filename from nested path", () => {
      const result = deriveFilenameFromUrl("https://host.com/path/to/report.md");
      expect(result).toBe("report.md");
    });

    it("handles percent-encoded filenames", () => {
      const result = deriveFilenameFromUrl("https://example.com/my%20file.txt");
      expect(result).toBe("my file.txt");
    });

    it("extracts filename with query string", () => {
      const result = deriveFilenameFromUrl("https://example.com/doc.html?v=2");
      expect(result).toBe("doc.html");
    });

    it("extracts filename with fragment", () => {
      const result = deriveFilenameFromUrl("https://example.com/page.html#section");
      expect(result).toBe("page.html");
    });
  });

  describe("edge cases and validation", () => {
    it("throws for invalid URL", () => {
      expect(() => deriveFilenameFromUrl("not-a-url")).toThrow("Invalid URL");
    });

    it("throws for non-http(s) protocol", () => {
      expect(() => deriveFilenameFromUrl("ftp://example.com/file.txt")).toThrow(
        "Only http(s) URLs are supported",
      );
    });

    it("throws for invalid percent-encoding in path segment", () => {
      expect(() => deriveFilenameFromUrl("https://example.com/file%ZZ.txt")).toThrow(
        "Invalid percent-encoding",
      );
    });

    it("extracts normalized filename when URL contains ..", () => {
      // URL constructor normalizes `..` in paths: `/docs/../file.txt` → `/file.txt`
      const result = deriveFilenameFromUrl("https://example.com/docs/../file.txt");
      expect(result).toBe("file.txt");
    });

    it("extracts directory name when path has trailing slash", () => {
      // `/docs/` splits to ['docs'] — the last non-empty segment
      const result = deriveFilenameFromUrl("https://example.com/docs/");
      expect(result).toBe("docs");
    });

    it("derives hostname-based filename when path decodes to root", () => {
      // `%2E%2E` decodes and normalizes to `/`, which has no segments
      const result = deriveFilenameFromUrl("https://example.com/%2E%2E");
      expect(result).toBe("example.com.html");
    });
  });

  describe("deterministic and filesystem-safe", () => {
    it("produces consistent filename for query-only URL", () => {
      const result1 = deriveFilenameFromUrl("https://example.com?q=search");
      const result2 = deriveFilenameFromUrl("https://example.com?q=search");
      expect(result1).toBe(result2);
      expect(result1).toBe("example.com.html");
    });

    it("produces filesystem-safe filename (no slashes)", () => {
      const result = deriveFilenameFromUrl("https://example.com");
      expect(result).not.toMatch(/[/\\]/);
    });

    it("produces non-empty filename", () => {
      const result = deriveFilenameFromUrl("https://a.co");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});

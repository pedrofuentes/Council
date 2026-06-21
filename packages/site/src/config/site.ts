/**
 * Static site configuration shared across Astro pages and build tooling.
 *
 * The Council site is deployed to the GitHub Pages project site at
 * https://pedrofuentes.github.io/Council/, so every internal URL must be
 * prefixed with the {@link basePath}.
 */

/** Origin the site is served from (GitHub Pages user/organisation domain). */
export const siteUrl = "https://pedrofuentes.github.io";

/** Project sub-path the site is mounted under, with leading and trailing slash. */
export const basePath = "/Council/";

/**
 * Prefix a site-relative route with {@link basePath}.
 *
 * The site root (`""` or `"/"`) maps to the base path itself; any other route
 * is normalised to a single leading slash and appended to the base path so the
 * `/Council/` prefix is always preserved.
 */
export function withBase(path: string): string {
  const baseWithoutTrailingSlash = basePath.replace(/\/$/, "");

  if (path === "" || path === "/") {
    return basePath;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseWithoutTrailingSlash}${normalizedPath}`;
}

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

/**
 * Resolve a site-relative route to a fully-qualified absolute URL.
 *
 * Combines {@link siteUrl} with {@link withBase} so the result is safe to use
 * for canonical links, Open Graph/Twitter image URLs, and JSON-LD — all of
 * which require absolute URLs to resolve correctly when shared off-site.
 */
export function absoluteUrl(path: string): string {
  return `${siteUrl}${withBase(path)}`;
}

/** Human-readable product name used across metadata. */
export const siteName = "Council";

/** One-line product tagline reused in the social card and metadata. */
export const siteTagline = "AI expert panels in your terminal";

/**
 * Default site description used as the metadata fallback.
 *
 * Kept provider-honest: Council ships on GitHub Copilot today, so the copy
 * avoids implying OpenAI/Anthropic support that is still on the roadmap.
 */
export const siteDescription =
  "Council convenes persistent panels of AI experts that deliberate, disagree, and remember — structured decisions you can defend, right in your terminal.";

/** Canonical source repository. */
export const githubUrl = "https://github.com/pedrofuentes/Council";

/** Published CLI package on npm. */
export const npmUrl = "https://www.npmjs.com/package/@council-ai/cli";

/** Site-relative path to the committed social-preview image. */
export const socialImagePath = "/og/council-og.png";

/** Absolute URL to the social-preview image (Open Graph / Twitter card). */
export const socialImageUrl = absoluteUrl(socialImagePath);

/** Accessible alt text for the social-preview image. */
export const socialImageAlt = `${siteName} — ${siteTagline}`;

/**
 * Schema.org `SoftwareApplication` structured data for the homepage.
 *
 * @see https://schema.org/SoftwareApplication
 */
export interface SoftwareApplicationLd {
  readonly "@context": "https://schema.org";
  readonly "@type": "SoftwareApplication";
  readonly name: string;
  readonly description: string;
  readonly applicationCategory: string;
  readonly operatingSystem: string;
  readonly url: string;
  readonly image: string;
  readonly downloadUrl: string;
  readonly codeRepository: string;
  readonly author: { readonly "@type": "Person"; readonly name: string };
  readonly license: string;
  readonly offers: {
    readonly "@type": "Offer";
    readonly price: string;
    readonly priceCurrency: string;
  };
}

/**
 * Build the homepage JSON-LD describing Council.
 *
 * Claims are deliberately verifiable: the free MIT licence is expressed as a
 * zero-price offer and no rating/review counts are fabricated.
 */
export function buildSoftwareApplicationLd(): SoftwareApplicationLd {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteName,
    description: siteDescription,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    url: absoluteUrl("/"),
    image: socialImageUrl,
    downloadUrl: npmUrl,
    codeRepository: githubUrl,
    author: { "@type": "Person", name: "Pedro Fuentes" },
    license: "https://opensource.org/licenses/MIT",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}

// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// GitHub Pages project site: https://pedrofuentes.github.io/Council/
// `site` is the deploy origin and `base` is the project sub-path. Both feed
// Astro's URL generation so internal links and assets resolve under /Council/.
const base = "/Council/";

export default defineConfig({
  site: "https://pedrofuentes.github.io",
  base,
  output: "static",
  // The marketing splash now renders at the site root (`/Council/`). Preserve
  // the previous `/Council/docs/` splash URL (and any external bookmarks to it)
  // by redirecting it to the new root home. Astro applies `base` to the redirect
  // source path but not the destination, so the destination uses `base` directly.
  redirects: {
    "/docs": base,
  },
  integrations: [
    starlight({
      title: "Council",
      // Fallback metadata description so every page emits og:description and a
      // meta description even when a page omits its own frontmatter description.
      // Provider-honest: Council ships on GitHub Copilot today.
      description:
        "Council convenes persistent panels of AI experts that deliberate, disagree, and remember — structured decisions you can defend, right in your terminal.",
      customCss: ["./src/styles/global.css"],
      // Augment Starlight's built-in <head> (canonical, Open Graph, Twitter
      // card, sitemap link) with social-preview image tags + homepage JSON-LD.
      components: {
        Head: "./src/components/Head.astro",
      },
      // Diátaxis information architecture: tutorials, how-to guides,
      // reference, and explanation sections for optimal documentation
      // discoverability.
      sidebar: [
        {
          label: "Start Here",
          link: "/",
        },
        {
          label: "Tutorials",
          items: [{ autogenerate: { directory: "tutorials" } }],
        },
        {
          label: "How-To Guides",
          items: [{ autogenerate: { directory: "how-to" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Explanation",
          items: [{ autogenerate: { directory: "explanation" } }],
        },
        {
          label: "Contributing",
          items: [{ label: "Overview", link: "/contributing/" }],
        },
        {
          label: "Versioning & Stability",
          link: "/versioning/",
        },
      ],
    }),
  ],
});

// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Council is deployed as a GitHub Pages project site at
// https://pedrofuent.es/Council/ via the custom domain configured on the
// pedrofuentes.github.io user-site repo. `site` is the canonical origin and
// `base` is the project sub-path. Both feed Astro's URL generation so
// canonical URLs, Open Graph tags, sitemap entries, and internal links all
// resolve correctly under /Council/.
const base = "/Council/";

export default defineConfig({
  site: "https://pedrofuent.es",
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
      customCss: ["./src/styles/global.css"],
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

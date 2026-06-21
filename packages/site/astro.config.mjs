// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// GitHub Pages project site: https://pedrofuentes.github.io/Council/
// `site` is the deploy origin and `base` is the project sub-path. Both feed
// Astro's URL generation so internal links and assets resolve under /Council/.
export default defineConfig({
  site: "https://pedrofuentes.github.io",
  base: "/Council/",
  output: "static",
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
          link: "/docs/",
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
          items: [{ label: "Overview", link: "/docs/contributing/" }],
        },
        {
          label: "Versioning & Stability",
          link: "/docs/versioning/",
        },
      ],
    }),
  ],
});

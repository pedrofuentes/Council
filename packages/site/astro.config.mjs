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
          items: [
            { label: "Overview", link: "/docs/tutorials/" },
            {
              label: "Beginner",
              items: [
                {
                  label: "1. Install and First Debate",
                  link: "/docs/tutorials/01-install-and-first-debate/",
                },
                {
                  label: "2. Conclude and Export",
                  link: "/docs/tutorials/02-conclude-and-export/",
                },
                {
                  label: "3. Built-in Templates",
                  link: "/docs/tutorials/03-built-in-templates/",
                },
                {
                  label: "4. Resume a Debate",
                  link: "/docs/tutorials/04-resume-a-debate/",
                },
              ],
            },
          ],
        },
        {
          label: "How-To Guides",
          items: [{ label: "Overview", link: "/docs/how-to/" }],
        },
        {
          label: "Reference",
          items: [{ label: "Overview", link: "/docs/reference/" }],
        },
        {
          label: "Explanation",
          items: [{ label: "Overview", link: "/docs/explanation/" }],
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

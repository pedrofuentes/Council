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
      // Minimal placeholder sidebar — the real information architecture is
      // owned by the documentation task that adds content under
      // src/content/docs/**.
      sidebar: [{ label: "Documentation", link: "/docs/" }],
    }),
  ],
});

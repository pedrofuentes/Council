import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

/**
 * Built-in panel library, sourced at build time from the CLI's panel YAMLs
 * (`packages/cli/panels/*.yaml`) — the single source of truth. Astro's `glob`
 * loader parses the YAML as data, so the gallery stays in sync with the CLI
 * without importing the CLI runtime into the site bundle. The schema captures
 * only the fields the gallery renders; richer expert detail in the YAML
 * (expertise, epistemic stance, defaults) is intentionally stripped.
 */
const panels = defineCollection({
  loader: glob({ pattern: "*.yaml", base: "../cli/panels" }),
  schema: z.object({
    name: z.string(),
    description: z.string(),
    experts: z
      .array(
        z.object({
          slug: z.string(),
          displayName: z.string(),
          role: z.string(),
        }),
      )
      .min(1),
    samplePrompts: z.array(z.string()).optional(),
    decisionArtifact: z.string().optional(),
    tags: z.array(z.string()).optional(),
    regulatedDomain: z.enum(["finance", "hr", "legal"]).optional(),
  }),
});

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  panels,
};

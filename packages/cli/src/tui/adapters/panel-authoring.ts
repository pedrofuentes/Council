import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as yaml from "yaml";

import { PanelDefinitionSchema } from "../../core/template-loader.js";

const PANEL_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface PanelAuthoringCreateInput {
  readonly name: string;
  readonly description: string | null;
  readonly expertSlugs: readonly string[];
  readonly mode?: string;
  readonly maxRounds?: number;
  readonly model?: string;
}

export interface PanelAuthoringDataSource {
  create(input: PanelAuthoringCreateInput): Promise<void>;
  setMembers(name: string, expertSlugs: readonly string[]): Promise<void>;
  countRetainedDebates(name: string): Promise<number>;
  delete(name: string): Promise<void>;
}

export interface PanelAuthoringDeps {
  readonly panelRepo: {
    create(input: {
      name: string;
      description: string | null;
      yamlPath: string;
      yamlChecksum: string;
    }): Promise<unknown>;
    findByName(name: string): Promise<unknown | undefined>;
    delete(name: string): Promise<void>;
    setMembers(name: string, slugs: readonly string[]): Promise<void>;
  };
  readonly expertExists: (slug: string) => Promise<boolean>;
  readonly dataHome: string;
  readonly countDebates: (name: string) => Promise<number>;
}

export function validatePanelName(name: string): void {
  if (!PANEL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid panel name "${name}": must be kebab-case (lowercase letters, digits, hyphens; must start with a letter)`,
    );
  }
}

function panelYamlPath(dataHome: string, name: string): string {
  return path.join(dataHome, "panels", `${name}.yaml`);
}

function panelDocsDir(dataHome: string, name: string): string {
  return path.join(dataHome, "panels", name, "docs");
}

function panelDir(dataHome: string, name: string): string {
  return path.join(dataHome, "panels", name);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

async function validateExpertSlugs(
  expertSlugs: readonly string[],
  expertExists: (slug: string) => Promise<boolean>,
): Promise<void> {
  for (const slug of expertSlugs) {
    if (!(await expertExists(slug))) {
      throw new Error(`Expert "${slug}" not found`);
    }
  }
}

export function createPanelAuthoringSource(deps: PanelAuthoringDeps): PanelAuthoringDataSource {
  return {
    async create(input): Promise<void> {
      validatePanelName(input.name);
      if ((await deps.panelRepo.findByName(input.name)) !== undefined) {
        throw new Error(`Panel "${input.name}" already exists`);
      }
      await validateExpertSlugs(input.expertSlugs, deps.expertExists);

      const defaults = {
        mode: input.mode ?? "freeform",
        ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      };
      const panel = PanelDefinitionSchema.parse({
        name: input.name,
        ...(input.description !== null ? { description: input.description } : {}),
        defaults,
        experts: input.expertSlugs,
      });
      const yamlPath = panelYamlPath(deps.dataHome, input.name);
      const yamlContent = yaml.stringify(panel);
      const yamlChecksum = sha256(yamlContent);

      await deps.panelRepo.create({
        name: input.name,
        description: input.description,
        yamlPath,
        yamlChecksum,
      });

      let yamlWritten = false;
      try {
        await fs.mkdir(path.dirname(yamlPath), { recursive: true });
        let handle: fs.FileHandle;
        try {
          handle = await fs.open(yamlPath, "wx");
        } catch (openErr) {
          if (errnoCode(openErr) === "EEXIST") {
            throw new Error(`Panel YAML already exists at ${yamlPath}`);
          }
          throw openErr;
        }
        yamlWritten = true;
        try {
          await handle.writeFile(yamlContent, "utf-8");
        } finally {
          await handle.close();
        }
        await deps.panelRepo.setMembers(input.name, input.expertSlugs);
        await fs.mkdir(panelDocsDir(deps.dataHome, input.name), { recursive: true });
      } catch (err) {
        try {
          await deps.panelRepo.delete(input.name);
        } catch {
          /* best-effort rollback */
        }
        if (yamlWritten) {
          try {
            await fs.unlink(yamlPath);
          } catch {
            /* best-effort rollback */
          }
        }
        throw err;
      }
    },

    async setMembers(name, expertSlugs): Promise<void> {
      await validateExpertSlugs(expertSlugs, deps.expertExists);
      await deps.panelRepo.setMembers(name, expertSlugs);
    },

    async countRetainedDebates(name): Promise<number> {
      return deps.countDebates(name);
    },

    async delete(name): Promise<void> {
      validatePanelName(name);
      if ((await deps.panelRepo.findByName(name)) === undefined) {
        throw new Error(`Panel "${name}" not found`);
      }
      const yamlPath = panelYamlPath(deps.dataHome, name);
      try {
        await fs.unlink(yamlPath);
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") {
          throw err;
        }
      }
      await fs.rm(panelDir(deps.dataHome, name), { recursive: true, force: true });
      await deps.panelRepo.delete(name);
    },
  };
}

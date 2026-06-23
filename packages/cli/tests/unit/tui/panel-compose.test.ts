import { describe, expect, it, vi } from "vitest";

import type { CouncilEngine } from "../../../src/engine/index.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import type { ResolvedPanelDefinition } from "../../../src/core/template-loader.js";
import type { PanelAuthoringDataSource } from "../../../src/tui/adapters/panel-authoring.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createPanelComposeSource } from "../../../src/tui/adapters/panel-compose.js";

const expert = (slug: string, displayName = slug): ExpertDefinition => ({
  slug,
  displayName,
  role: `Role for ${displayName}`,
  expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
  epistemicStance: "evidence first",
  kind: "generic",
});

const definition = (overrides: Partial<ResolvedPanelDefinition> = {}): ResolvedPanelDefinition => ({
  name: "strategy-panel",
  description: "Strategic debate",
  defaults: { mode: "structured", maxRounds: 4, model: "mock-model" },
  experts: [expert("optimist", "Optimist"), expert("skeptic", "Skeptic")],
  ...overrides,
});

interface StubEngine extends CouncilEngine {
  readonly start: ReturnType<typeof vi.fn<[], Promise<void>>>;
  readonly stop: ReturnType<typeof vi.fn<[], Promise<void>>>;
}

const createEngine = (): StubEngine => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  addExpert: vi.fn(async () => undefined),
  removeExpert: vi.fn(async () => undefined),
  send: vi.fn(() =>
    (async function* stream(): AsyncIterable<never> {
      yield* [];
    })(),
  ),
  listModels: vi.fn(async () => []),
});

const createLibrary = (existing: readonly string[] = []) => {
  const existingSlugs = new Set(existing);
  return {
    created: [] as ExpertDefinition[],
    deleted: [] as string[],
    get: vi.fn(async (slug: string) => (existingSlugs.has(slug) ? { slug } : null)),
    create: vi.fn(async (def: ExpertDefinition) => {
      existingSlugs.add(def.slug);
      return undefined;
    }),
    delete: vi.fn(async (slug: string, _options: { readonly force: boolean }) => {
      existingSlugs.delete(slug);
      return { affectedPanels: [] as readonly string[] };
    }),
  };
};

describe("createPanelComposeSource", () => {
  it("composes with an engine, stops it, and returns a sanitized preview", async () => {
    const engine = createEngine();
    const raw = definition({
      name: "panel\n\u001B[31mname",
      description: "desc\n\u001B[32mtext",
      experts: [expert("optimist", "Opt\n\u001B[31mist")],
    });
    const composeFn = vi.fn(async () => raw);
    const source = createPanelComposeSource({
      engineFactory: () => engine,
      defaultModel: "mock-model",
      library: createLibrary(),
      createPanel: vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(),
      composeFn,
    });

    const preview = await source.compose("launch topic", { minExperts: 2, maxExperts: 4 });

    expect(engine.start).toHaveBeenCalledOnce();
    expect(composeFn).toHaveBeenCalledWith("launch topic", engine, {
      minExperts: 2,
      maxExperts: 4,
      defaultModel: "mock-model",
    });
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(preview.name).toBe("panel name");
    expect(preview.description).toBe("desc text");
    expect(preview.experts).toEqual([{ displayName: "Opt ist", role: "Role for Opt ist" }]);
    expect(preview.definition).toBe(raw);
  });

  it("omits undefined compose options and maps missing descriptions to null", async () => {
    const engine = createEngine();
    const raw = definition({ description: undefined });
    const composeFn = vi.fn(async () => raw);
    const source = createPanelComposeSource({
      engineFactory: () => engine,
      defaultModel: "fallback-model",
      library: createLibrary(),
      createPanel: vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(),
      composeFn,
    });

    const preview = await source.compose("topic");

    expect(composeFn).toHaveBeenCalledWith("topic", engine, { defaultModel: "fallback-model" });
    expect(preview.description).toBeNull();
  });

  it("uses autoComposePanel by default with MockEngine and swallows stop failures", async () => {
    const engine = new MockEngine();
    const stop = vi.spyOn(engine, "stop").mockRejectedValueOnce(new Error("stop failed"));
    const source = createPanelComposeSource({
      engineFactory: () => engine,
      defaultModel: "mock-model",
      library: createLibrary(),
      createPanel: vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(),
    });

    const preview = await source.compose("offline topic", { maxExperts: 1 });

    expect(stop).toHaveBeenCalledOnce();
    expect(preview.name).toBe("mock-panel");
    expect(preview.experts).toHaveLength(1);
  });

  it("stops the engine and propagates compose failures", async () => {
    const engine = createEngine();
    const error = new Error("compose failed");
    const source = createPanelComposeSource({
      engineFactory: () => engine,
      defaultModel: "mock-model",
      library: createLibrary(),
      createPanel: vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(),
      composeFn: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(source.compose("topic")).rejects.toThrow(error);
    expect(engine.stop).toHaveBeenCalledOnce();
  });

  it("persists inline experts then creates a panel with the materialized slugs", async () => {
    const library = createLibrary();
    const createPanel = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(
      async () => undefined,
    );
    const source = createPanelComposeSource({
      engineFactory: createEngine,
      defaultModel: "mock-model",
      library,
      createPanel,
      composeFn: vi.fn(async () => definition()),
    });

    await expect(source.persist(definition())).resolves.toEqual({ panelName: "strategy-panel" });

    expect(library.create).toHaveBeenCalledWith(expect.objectContaining({ slug: "optimist" }));
    expect(library.create).toHaveBeenCalledWith(expect.objectContaining({ slug: "skeptic" }));
    expect(createPanel).toHaveBeenCalledWith({
      name: "strategy-panel",
      description: "Strategic debate",
      expertSlugs: ["optimist", "skeptic"],
      mode: "structured",
      maxRounds: 4,
      model: "mock-model",
    });
  });

  it("resolves slug collisions before materializing experts", async () => {
    const library = createLibrary(["optimist"]);
    const createPanel = vi.fn<Parameters<PanelAuthoringDataSource["create"]>, Promise<void>>(
      async () => undefined,
    );
    const source = createPanelComposeSource({
      engineFactory: createEngine,
      defaultModel: "mock-model",
      library,
      createPanel,
      composeFn: vi.fn(async () => definition()),
    });

    await source.persist(definition({ experts: [expert("optimist", "Optimist")] }));

    expect(library.get).toHaveBeenCalledWith("optimist");
    expect(library.get).toHaveBeenCalledWith("optimist-2");
    expect(library.create).toHaveBeenCalledWith(expect.objectContaining({ slug: "optimist-2" }));
    expect(createPanel).toHaveBeenCalledWith(
      expect.objectContaining({ expertSlugs: ["optimist-2"] }),
    );
  });

  it("omits nullable panel fields and rethrows when rollback delete is unavailable", async () => {
    const library = {
      get: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
    };
    const error = new Error("panel create failed");
    const source = createPanelComposeSource({
      engineFactory: createEngine,
      defaultModel: "mock-model",
      library,
      createPanel: vi.fn(async () => {
        throw error;
      }),
      composeFn: vi.fn(async () => definition()),
    });

    await expect(
      source.persist(
        definition({ description: undefined, defaults: undefined, experts: [expert("solo")] }),
      ),
    ).rejects.toThrow(error);
  });

  it("continues rollback when deleting one created expert fails", async () => {
    const library = createLibrary();
    library.delete.mockRejectedValueOnce(new Error("delete failed"));
    const source = createPanelComposeSource({
      engineFactory: createEngine,
      defaultModel: "mock-model",
      library,
      createPanel: vi.fn(async () => {
        throw new Error("panel create failed");
      }),
      composeFn: vi.fn(async () => definition()),
    });

    await expect(source.persist(definition())).rejects.toThrow("panel create failed");

    expect(library.delete).toHaveBeenCalledTimes(2);
  });

  it("rolls back experts created in this call when panel creation fails", async () => {
    const library = createLibrary();
    const error = new Error("panel create failed");
    const source = createPanelComposeSource({
      engineFactory: createEngine,
      defaultModel: "mock-model",
      library,
      createPanel: vi.fn(async () => {
        throw error;
      }),
      composeFn: vi.fn(async () => definition()),
    });

    await expect(source.persist(definition())).rejects.toThrow(error);

    expect(library.delete).toHaveBeenCalledWith("optimist", { force: true });
    expect(library.delete).toHaveBeenCalledWith("skeptic", { force: true });
  });
});

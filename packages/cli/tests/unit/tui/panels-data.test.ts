import { describe, expect, it } from "vitest";

import { createPanelsDataSource, type PanelsRepos } from "../../../src/tui/adapters/panels-data.js";

describe("createPanelsDataSource.loadList", () => {
  it("lists saved panels then templates with member counts", async () => {
    const loadedTemplates: string[] = [];
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [
          { name: "acme", description: "Exec panel" },
          { name: "bare", description: null },
        ],
        findByName: async () => undefined,
        getMembers: async (name) => (name === "acme" ? ["cto", "cfo"] : []),
        getMemberCounts: async () => new Map([["acme", 2]]),
      },
      experts: { get: async () => null },
      listTemplates: async () => ["startup-board", "blank-template"],
      loadTemplate: async (name) => {
        loadedTemplates.push(name);
        return name === "startup-board"
          ? {
              description: `tpl ${name}`,
              experts: [
                { slug: "a", displayName: "A", role: "Role A", kind: "generic" },
                { slug: "b", displayName: "B", role: "Role B", kind: "persona" },
                { slug: "c", displayName: "C", role: "Role C", kind: "generic" },
              ],
            }
          : { experts: [] };
      },
    });

    const list = await ds.loadList();

    expect(list).toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "bare", description: "", memberCount: 0, source: "saved" },
      {
        name: "startup-board",
        description: "tpl startup-board",
        memberCount: 3,
        source: "template",
      },
      { name: "blank-template", description: "", memberCount: 0, source: "template" },
    ]);
    expect(loadedTemplates).toEqual(["startup-board", "blank-template"]);
  });

  it("returns an empty array when there are no panels or templates", async () => {
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map(),
      },
      experts: { get: async () => null },
      listTemplates: async () => [],
      loadTemplate: async () => ({ experts: [] }),
    });

    expect(await ds.loadList()).toEqual([]);
  });

  it("resolves saved member counts with one aggregate query, not per-panel getMembers (#1599)", async () => {
    const getMembersCalls: string[] = [];
    let countCalls = 0;
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [
          { name: "acme", description: "Exec panel" },
          { name: "bare", description: null },
          { name: "solo", description: "One" },
        ],
        findByName: async () => undefined,
        getMembers: async (name) => {
          getMembersCalls.push(name);
          return [];
        },
        getMemberCounts: async () => {
          countCalls += 1;
          return new Map([
            ["acme", 4],
            ["solo", 1],
          ]);
        },
      },
      experts: { get: async () => null },
      listTemplates: async () => [],
      loadTemplate: async () => ({ experts: [] }),
    });

    const list = await ds.loadList();

    expect(countCalls).toBe(1);
    expect(getMembersCalls).toEqual([]);
    expect(list).toEqual([
      { name: "acme", description: "Exec panel", memberCount: 4, source: "saved" },
      { name: "bare", description: "", memberCount: 0, source: "saved" },
      { name: "solo", description: "One", memberCount: 1, source: "saved" },
    ]);
  });

  // #1817 (from Sentinel review of PR #1813): the `listTemplates` call must not
  // discard already-resolved saved panels. A template listing/loading failure
  // has to degrade the *template* portion only — the saved panels the user
  // already has must still be returned (and therefore rendered).
  it("still returns saved panels when listTemplates throws, degrading templates to empty (#1817)", async () => {
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [
          { name: "acme", description: "Exec panel" },
          { name: "bare", description: null },
        ],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map([["acme", 2]]),
      },
      experts: { get: async () => null },
      listTemplates: async () => {
        throw new Error("template listing failed");
      },
      loadTemplate: async () => ({ experts: [] }),
    });

    // Before the fix the whole result was lost; the saved panels must survive
    // and the template portion must degrade to empty (no template entries).
    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "bare", description: "", memberCount: 0, source: "saved" },
    ]);
  });

  it("still returns saved panels when a template fails to load (#1817)", async () => {
    const loadedTemplates: string[] = [];
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [{ name: "acme", description: "Exec panel" }],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map([["acme", 2]]),
      },
      experts: { get: async () => null },
      listTemplates: async () => ["startup-board", "broken"],
      loadTemplate: async (name) => {
        loadedTemplates.push(name);
        if (name === "broken") throw new Error("template file corrupt");
        return { description: "tpl", experts: [] };
      },
    });

    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
    ]);
  });

  it("returns saved panels AND templates unchanged when template loading succeeds (inverse, #1817)", async () => {
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [{ name: "acme", description: "Exec panel" }],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map([["acme", 2]]),
      },
      experts: { get: async () => null },
      listTemplates: async () => ["startup-board"],
      loadTemplate: async () => ({
        description: "tpl",
        experts: [{ slug: "a", displayName: "A", role: "Role A", kind: "generic" }],
      }),
    });

    // The guard must not drop or alter valid template data on the happy path.
    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "startup-board", description: "tpl", memberCount: 1, source: "template" },
    ]);
  });
});

describe("createPanelsDataSource.loadDetail", () => {
  const createRepos = (overrides: Partial<PanelsRepos> = {}): PanelsRepos => ({
    library: {
      findAll: async () => [],
      findByName: async () => ({ name: "acme", description: "Exec panel" }),
      getMembers: async () => [],
      getMemberCounts: async () => new Map(),
    },
    experts: { get: async () => null },
    listTemplates: async () => [],
    loadTemplate: async () => ({ experts: [] }),
    ...overrides,
  });

  it("loads saved panel detail with resolved and missing members", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        library: {
          findAll: async () => [],
          findByName: async () => ({ name: "acme", description: "Exec panel" }),
          getMembers: async () => ["cto", "ghost"],
        },
        experts: {
          get: async (slug) =>
            slug === "cto"
              ? { displayName: "Chief Tech", role: "Technology", kind: "generic" }
              : null,
        },
      }),
    );

    await expect(ds.loadDetail("acme", "saved")).resolves.toEqual({
      name: "acme",
      description: "Exec panel",
      source: "saved",
      members: [
        {
          slug: "cto",
          displayName: "Chief Tech",
          role: "Technology",
          kind: "generic",
        },
      ],
      missing: ["ghost"],
    });
  });

  it("returns undefined when a saved panel is not found", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        library: {
          findAll: async () => [],
          findByName: async () => undefined,
          getMembers: async () => ["unused"],
        },
      }),
    );

    await expect(ds.loadDetail("missing", "saved")).resolves.toBeUndefined();
  });

  it("loads template detail with defaults and mapped members", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        loadTemplate: async () => ({
          description: "Template panel",
          defaults: { mode: "structured", maxRounds: 3, model: "gpt-test" },
          experts: [
            {
              slug: "cto",
              displayName: "Chief Tech",
              role: "Technology",
              kind: "generic",
            },
            {
              slug: "coach",
              displayName: "Coach",
              role: "Guidance",
              kind: "persona",
            },
          ],
        }),
      }),
    );

    await expect(ds.loadDetail("startup-board", "template")).resolves.toEqual({
      name: "startup-board",
      description: "Template panel",
      source: "template",
      defaults: { mode: "structured", maxRounds: 3, model: "gpt-test" },
      members: [
        {
          slug: "cto",
          displayName: "Chief Tech",
          role: "Technology",
          kind: "generic",
        },
        {
          slug: "coach",
          displayName: "Coach",
          role: "Guidance",
          kind: "persona",
        },
      ],
      missing: [],
    });
  });

  it("uses an empty description for templates with omitted descriptions", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        loadTemplate: async () => ({
          experts: [
            {
              slug: "cto",
              displayName: "Chief Tech",
              role: "Technology",
              kind: "generic",
            },
          ],
        }),
      }),
    );

    await expect(ds.loadDetail("blank-template", "template")).resolves.toMatchObject({
      name: "blank-template",
      description: "",
      source: "template",
      members: [
        {
          slug: "cto",
          displayName: "Chief Tech",
          role: "Technology",
          kind: "generic",
        },
      ],
      missing: [],
    });
  });

  it("omits undefined template default fields", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        loadTemplate: async () => ({
          defaults: { mode: "freeform", maxRounds: undefined, model: undefined },
          experts: [],
        }),
      }),
    );

    await expect(ds.loadDetail("partial-defaults", "template")).resolves.toStrictEqual({
      name: "partial-defaults",
      description: "",
      source: "template",
      defaults: { mode: "freeform" },
      members: [],
      missing: [],
    });
  });

  it("maps template defaults when mode is omitted", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        loadTemplate: async () => ({
          defaults: { maxRounds: 2 },
          experts: [],
        }),
      }),
    );

    await expect(ds.loadDetail("rounds-only", "template")).resolves.toStrictEqual({
      name: "rounds-only",
      description: "",
      source: "template",
      defaults: { maxRounds: 2 },
      members: [],
      missing: [],
    });
  });

  it("uses an empty description for saved panels with null descriptions", async () => {
    const ds = createPanelsDataSource(
      createRepos({
        library: {
          findAll: async () => [],
          findByName: async () => ({ name: "bare", description: null }),
          getMembers: async () => [],
        },
      }),
    );

    await expect(ds.loadDetail("bare", "saved")).resolves.toMatchObject({
      name: "bare",
      description: "",
      source: "saved",
      members: [],
      missing: [],
    });
  });
});

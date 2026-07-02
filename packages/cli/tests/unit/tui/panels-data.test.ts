import { describe, expect, it, vi } from "vitest";

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
  //
  // #2046 (from Sentinel review of PR #2041): the degraded mode was silently
  // swallowed AND — because the inner join was `Promise.all` — one bad template
  // collapsed the ENTIRE template set. The loader must (a) isolate a single bad
  // template with `Promise.allSettled` so only it is dropped, and (b) surface
  // the fallback through the injected `onWarning` sink so the failure is
  // observable, never silent.
  it("warns and returns saved panels when listTemplates rejects, degrading templates to empty (#1817, #2046)", async () => {
    const warnings: string[] = [];
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
      onWarning: (message) => warnings.push(message),
    });

    // #1817: the saved panels must survive and the template portion must
    // degrade to empty (no template entries).
    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "bare", description: "", memberCount: 0, source: "saved" },
    ]);

    // #2046: the degraded mode must be observable, not silently swallowed. The
    // warning is discriminating — it names the template subsystem and carries
    // the underlying failure so a loader regression is diagnosable.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("template");
    expect(warnings[0]).toContain("template listing failed");
  });

  it("warns and drops only the failed template, keeping the healthy ones (#1817, #2046)", async () => {
    const warnings: string[] = [];
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
        if (name === "broken") throw new Error("template file corrupt");
        return { description: "tpl", experts: [] };
      },
      onWarning: (message) => warnings.push(message),
    });

    // #2046: a single bad template must skip ONLY itself — the valid
    // "startup-board" template must still be listed. This proves the join uses
    // `Promise.allSettled`; `Promise.all` would short-circuit and collapse the
    // whole template set to the saved-only list.
    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "startup-board", description: "tpl", memberCount: 0, source: "template" },
    ]);

    // The warning names the failed template and does NOT implicate the healthy
    // one, so the diagnostic points at the real culprit.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken");
    expect(warnings[0]).not.toContain("startup-board");
  });

  it("keeps every healthy template when one of several fails, naming only the bad one (#2046)", async () => {
    const warnings: string[] = [];
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map(),
      },
      experts: { get: async () => null },
      listTemplates: async () => ["alpha", "corrupt", "omega"],
      loadTemplate: async (name) => {
        if (name === "corrupt") throw new Error("malformed template");
        return { description: `tpl ${name}`, experts: [] };
      },
      onWarning: (message) => warnings.push(message),
    });

    // Two healthy templates survive on either side of the malformed one.
    await expect(ds.loadList()).resolves.toEqual([
      { name: "alpha", description: "tpl alpha", memberCount: 0, source: "template" },
      { name: "omega", description: "tpl omega", memberCount: 0, source: "template" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("corrupt");
    expect(warnings[0]).not.toContain("alpha");
    expect(warnings[0]).not.toContain("omega");
  });

  it("sanitizes untrusted template names before they reach the warning sink (#2046)", async () => {
    const warnings: string[] = [];
    // A hand-edited/hostile template filename could embed ANSI + newlines to
    // forge log lines or spoof terminal output when the degraded-mode warning
    // is echoed. The failed name must be collapsed to one sanitized line.
    const hostileName = "ev\u001b[31mil\nname";
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map(),
      },
      experts: { get: async () => null },
      listTemplates: async () => [hostileName],
      loadTemplate: async () => {
        throw new Error("corrupt");
      },
      onWarning: (message) => warnings.push(message),
    });

    await expect(ds.loadList()).resolves.toEqual([]);
    expect(warnings).toHaveLength(1);
    // Control/ANSI stripped, newline collapsed → a single safe line.
    expect(warnings[0]).not.toContain("\u001b");
    expect(warnings[0]).not.toContain("\n");
    expect(warnings[0]).toContain("evil name");
  });

  it("returns saved panels AND templates unchanged and emits no warning when loads succeed (inverse, #1817, #2046)", async () => {
    const warnings: string[] = [];
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
      onWarning: (message) => warnings.push(message),
    });

    // The guard must not drop or alter valid template data on the happy path...
    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "startup-board", description: "tpl", memberCount: 1, source: "template" },
    ]);
    // ...and the all-valid path must stay silent — no false-positive diagnostics.
    expect(warnings).toEqual([]);
  });

  // #2111 (Sentinel CONDITIONAL follow-up of PR #2107): the per-template failure
  // warning listed the failed NAMES only, dropping `result.reason` — unlike the
  // total-failure path which includes `${errorText(error)}`. An operator learned
  // *which* template failed but not *why*. The warning must carry the underlying
  // reason per failed template (name: reason), consistent with the sibling path.
  it("includes the underlying failure reason, not just the name, per failed template (#2111)", async () => {
    const warnings: string[] = [];
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
        if (name === "broken") throw new Error("template file corrupt");
        return { description: "tpl", experts: [] };
      },
      onWarning: (message) => warnings.push(message),
    });

    await ds.loadList();

    expect(warnings).toHaveLength(1);
    // Discriminating: the warning names the culprit AND carries WHY it failed.
    expect(warnings[0]).toContain("broken");
    expect(warnings[0]).toContain("template file corrupt");
    // ...without implicating the healthy template that loaded fine.
    expect(warnings[0]).not.toContain("startup-board");
  });

  // #2111 🟡 3 — the `console.warn` fallback (the ACTUAL production path today,
  // since callers were unwired) had no test. Assert it fires when no sink is
  // wired AND that it now carries the failure reason (discriminating, not a bare
  // "was called").
  it("falls back to console.warn carrying the failure reason when no onWarning sink is wired (#2111)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const ds = createPanelsDataSource({
        library: {
          findAll: async () => [],
          findByName: async () => undefined,
          getMembers: async () => [],
          getMemberCounts: async () => new Map(),
        },
        experts: { get: async () => null },
        listTemplates: async () => ["broken"],
        loadTemplate: async () => {
          throw new Error("template file corrupt");
        },
        // no onWarning — degraded mode must still be observable via console.warn.
      });

      await expect(ds.loadList()).resolves.toEqual([]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("broken");
      expect(message).toContain("template file corrupt");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #2111 🟡 3 — a throwing `onWarning` sink must never break the best-effort
  // list: observability cannot degrade the data path. loadList must still resolve
  // with the survivors (saved + healthy templates), with no unhandled rejection.
  it("keeps loadList resolving with survivors when the onWarning sink itself throws (#2111)", async () => {
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
        if (name === "broken") throw new Error("corrupt");
        return { description: "tpl", experts: [] };
      },
      onWarning: () => {
        throw new Error("the warning sink is broken");
      },
    });

    await expect(ds.loadList()).resolves.toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "startup-board", description: "tpl", memberCount: 0, source: "template" },
    ]);
  });

  // #2111 — the reason is untrusted (an Error message can echo file-derived
  // bytes), just like the name. BOTH must be collapsed to a single sanitized
  // line before reaching the sink so a crafted template cannot forge log lines
  // or inject terminal-control sequences.
  it("sanitizes adversarial bytes in BOTH the failed name and its reason to one line (#2111)", async () => {
    const warnings: string[] = [];
    const hostileName = "al\u001b[31mpha\u0007-\u202etemplate";
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [],
        findByName: async () => undefined,
        getMembers: async () => [],
        getMemberCounts: async () => new Map(),
      },
      experts: { get: async () => null },
      listTemplates: async () => [hostileName],
      loadTemplate: async () => {
        throw new Error("mal\u0000formed\u2028rea\tson\u202c");
      },
      onWarning: (message) => warnings.push(message),
    });

    await expect(ds.loadList()).resolves.toEqual([]);
    expect(warnings).toHaveLength(1);
    const message = warnings[0] ?? "";
    // Readable name and reason survive...
    expect(message).toContain("alpha-template");
    expect(message).toContain("malformed rea son");
    // ...but no control / bidi bytes, and the whole message stays single-line.
    expect(message).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
    );
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

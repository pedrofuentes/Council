import { describe, expect, it } from "vitest";

import { createPanelsDataSource } from "../../../src/tui/adapters/panels-data.js";

describe("createPanelsDataSource.loadList", () => {
  it("lists saved panels then templates with member counts", async () => {
    const loadedTemplates: string[] = [];
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [
          { name: "acme", description: "Exec panel" },
          { name: "bare", description: null },
        ],
        getMembers: async (name) => (name === "acme" ? ["cto", "cfo"] : []),
      },
      listTemplates: async () => ["startup-board", "blank-template"],
      loadTemplate: async (name) => {
        loadedTemplates.push(name);
        return name === "startup-board"
          ? { description: `tpl ${name}`, experts: [{}, {}, {}] }
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
      library: { findAll: async () => [], getMembers: async () => [] },
      listTemplates: async () => [],
      loadTemplate: async () => ({ experts: [] }),
    });

    expect(await ds.loadList()).toEqual([]);
  });
});

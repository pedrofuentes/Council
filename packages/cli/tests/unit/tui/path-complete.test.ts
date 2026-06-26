import { describe, expect, it } from "vitest";

import { completePath } from "../../../src/tui/lib/path-complete.js";

const fakeReaddir =
  (map: Record<string, readonly string[]>) =>
  async (dir: string): Promise<readonly string[]> =>
    map[dir] ?? [];

const fakeIsDirectory =
  (dirs: ReadonlySet<string>) =>
  async (p: string): Promise<boolean> =>
    dirs.has(p);

describe("completePath", () => {
  it("filters candidates by partial basename prefix", async () => {
    const readdir = fakeReaddir({ ".": ["foo.md", "bar.md", "baz.md"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("b", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./bar.md", "./baz.md"]);
    expect(result.completed).toBe("./ba");
  });

  it("returns full match when only one candidate", async () => {
    const readdir = fakeReaddir({ ".": ["only.md", "other.md"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("on", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./only.md"]);
    expect(result.completed).toBe("./only.md");
  });

  it("appends trailing slash when sole candidate is a directory", async () => {
    const readdir = fakeReaddir({ ".": ["docs", "readme.md"] });
    const isDirectory = fakeIsDirectory(new Set(["./docs"]));

    const result = await completePath("doc", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./docs"]);
    expect(result.completed).toBe("./docs/");
  });

  it("does NOT append slash when multiple candidates even if one is a directory", async () => {
    const readdir = fakeReaddir({ ".": ["docs", "downloads"] });
    const isDirectory = fakeIsDirectory(new Set(["./docs", "./downloads"]));

    const result = await completePath("do", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./docs", "./downloads"]);
    expect(result.completed).toBe("./do");
  });

  it("returns input + empty candidates when no match", async () => {
    const readdir = fakeReaddir({ ".": ["foo.md"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("zzz", { readdir, isDirectory });

    expect(result.candidates).toEqual([]);
    expect(result.completed).toBe("zzz");
  });

  it("handles empty input by listing cwd", async () => {
    const readdir = fakeReaddir({ ".": ["alpha.md", "beta.md"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./alpha.md", "./beta.md"]);
    expect(result.completed).toBe("./");
  });

  it("completes inside a subdirectory", async () => {
    const readdir = fakeReaddir({ "./docs": ["strategy.md", "roadmap.md"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("./docs/str", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./docs/strategy.md"]);
    expect(result.completed).toBe("./docs/strategy.md");
  });

  it("completes with absolute paths", async () => {
    const readdir = fakeReaddir({ "/home/user": ["notes.md", "notes-old.md"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("/home/user/not", { readdir, isDirectory });

    expect(result.candidates).toEqual(["/home/user/notes.md", "/home/user/notes-old.md"]);
    expect(result.completed).toBe("/home/user/notes");
  });

  it("gracefully returns input + empty candidates on a missing directory", async () => {
    const readdir = async (_dir: string): Promise<readonly string[]> => {
      throw new Error("ENOENT");
    };
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("./missing/path", { readdir, isDirectory });

    expect(result.candidates).toEqual([]);
    expect(result.completed).toBe("./missing/path");
  });

  it("computes the longest common prefix for multiple candidates", async () => {
    const readdir = fakeReaddir({ ".": ["strategy.md", "strategic.md", "struct.ts"] });
    const isDirectory = fakeIsDirectory(new Set());

    const result = await completePath("st", { readdir, isDirectory });

    expect(result.candidates).toEqual(["./strategy.md", "./strategic.md", "./struct.ts"]);
    // longest common prefix of "strategy.md", "strategic.md", "struct.ts" from ./ base is "str"
    expect(result.completed).toBe("./str");
  });
});

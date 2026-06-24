import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileExclusive } from "../../../src/tui/lib/safe-write.js";

describe("writeFileExclusive", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "council-export-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes content to a new path", async () => {
    const path = join(dir, "new.md");

    await writeFileExclusive(path, "HELLO");

    expect(await fs.readFile(path, "utf8")).toBe("HELLO");
  });

  it("refuses to overwrite an existing file (no clobber)", async () => {
    const path = join(dir, "exists.md");
    await fs.writeFile(path, "ORIGINAL");

    await expect(writeFileExclusive(path, "NEW")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(path, "utf8")).toBe("ORIGINAL");
  });

  it("refuses to follow a symlink to clobber its target", async () => {
    const target = join(dir, "target.md");
    await fs.writeFile(target, "TARGET");
    const link = join(dir, "link.md");
    await fs.symlink(target, link);

    await expect(writeFileExclusive(link, "EVIL")).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("TARGET");
  });
});

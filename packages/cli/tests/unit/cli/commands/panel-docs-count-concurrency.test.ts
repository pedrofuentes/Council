/**
 * `panel docs link` document count fans out with BOUNDED concurrency (#2273).
 *
 * `countSupportedFiles` walks a user-supplied folder with
 * `fs.readdir(dir, { recursive: true })` and then `lstat`s every entry to
 * decide whether it is a supported document. The recursive listing is
 * user-controlled and unbounded: a deep/wide linked folder yields an
 * arbitrarily large entry list, and firing one `lstat` per entry through a
 * single `Promise.all` opens that many concurrent filesystem handles at once —
 * a resource-exhaustion (EMFILE / descriptor-starvation) vector.
 *
 * The fix must cap the in-flight `lstat` count while keeping behavior
 * identical (same total count, per-entry failures still skipped). This test
 * injects a counting `lstat` seam (the production one cannot be `vi.spyOn`ed —
 * `node:fs/promises` namespace bindings are non-configurable, mirroring the
 * scanner's `_detectorLstatOverride`) and asserts the observed peak
 * concurrency stays bounded well below the total number of entries, while the
 * returned count is exactly the number of supported files.
 *
 * RED before the fix: the unbounded `Promise.all` drives peak concurrency to
 * the full entry count.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countSupportedFiles } from "../../../../src/cli/commands/panel.js";

// Must not exceed the DOCS_COUNT_CONCURRENCY cap in panel.ts. Kept as a local
// constant so the assertion documents the contract; if the impl cap changes
// above this value the test correctly fails.
const MAX_CONCURRENCY = 16;

const SUPPORTED_TOP = 40;
const UNSUPPORTED_TOP = 6;
const SUPPORTED_NESTED = 4;
const SUPPORTED_TOTAL = SUPPORTED_TOP + SUPPORTED_NESTED;

let dir: string;

async function seedTree(root: string): Promise<void> {
  for (let i = 0; i < SUPPORTED_TOP; i += 1) {
    await fs.writeFile(path.join(root, `doc-${String(i).padStart(3, "0")}.md`), "x", "utf-8");
  }
  for (let i = 0; i < UNSUPPORTED_TOP; i += 1) {
    await fs.writeFile(path.join(root, `note-${i}.log`), "x", "utf-8");
  }
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  for (let i = 0; i < SUPPORTED_NESTED; i += 1) {
    await fs.writeFile(path.join(nested, `n-${i}.md`), "x", "utf-8");
  }
}

describe("countSupportedFiles — bounded fan-out concurrency (#2273)", () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-docs-count-"));
    await seedTree(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("caps concurrent lstat calls while returning the exact supported count", async () => {
    const realLstat = fs.lstat;
    let inFlight = 0;
    let peak = 0;
    const countingLstat = async (p: string): Promise<Stats> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await realLstat(p);
      } finally {
        inFlight -= 1;
      }
    };

    const count = await countSupportedFiles(dir, new Set([".md"]), countingLstat);

    // Behavior is unchanged: every supported file (top-level + nested) counted.
    expect(count).toBe(SUPPORTED_TOTAL);
    // The fan-out actually ran in parallel (not serialized to 1)...
    expect(peak).toBeGreaterThan(1);
    // ...but never opened more than the cap of concurrent handles, even though
    // the recursive listing has far more entries than the cap.
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });
});

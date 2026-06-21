/**
 * Test helper — create a canonical (realpath'd) temporary directory.
 *
 * On macOS `os.tmpdir()` returns `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`. Production code canonicalizes a docs root with
 * `fs.realpath` before scanning (see `processor.ts` `resolveRealRoot`) and
 * then trusts `_rootIsCanonical: true`, resolving each FILE to its real path
 * and checking it lives under that already-canonical root.
 *
 * Tests that pass a raw `mkdtemp` path as `confinementRoot` together with
 * `_rootIsCanonical: true` therefore lie on macOS: the "canonical" root is
 * `/var/…` while files resolve to `/private/var/…`, so every file looks
 * outside the confinement root and the scan returns nothing. Linux `/tmp`
 * is not a symlink, hiding the bug there.
 *
 * Using this helper makes the `_rootIsCanonical: true` claim truthful on all
 * platforms, matching the canonical root production always provides.
 *
 * Usage (in test files):
 * ```ts
 * import { mkCanonicalTempDir } from "../../helpers/tmp.js";
 *
 * beforeEach(async () => {
 *   dir = await mkCanonicalTempDir("council-detect-");
 * });
 * ```
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Create a temporary directory under `os.tmpdir()` with the given `prefix`
 * and return its canonical (realpath'd) absolute path.
 */
export async function mkCanonicalTempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

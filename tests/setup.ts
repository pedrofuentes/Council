/**
 * Vitest setup — global test isolation.
 *
 * Sets COUNCIL_HOME to a per-process temp directory BEFORE any test code
 * runs, so commands like `council doctor` and `council panels` (which
 * resolve filesystem paths via getCouncilHome()) cannot pollute the
 * user's real `~/.council/` directory.
 *
 * The temp directory is unique per process and deleted on exit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "council-test-home-"));
process.env["COUNCIL_HOME"] = TEST_HOME;

process.on("exit", () => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

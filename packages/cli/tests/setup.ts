/**
 * Vitest setup — global test isolation.
 *
 * Sets COUNCIL_HOME to a per-process temp directory BEFORE any test code
 * runs, so commands like `council doctor` and `council panels` (which
 * resolve filesystem paths via getCouncilHome()) cannot pollute the
 * user's real `~/.council/` directory.
 *
 * The temp directory is unique per process and deleted on exit.
 *
 * Also forces chalk's color level to 3 so renderer tests (Ink, Plain)
 * can assert against the SGR escape sequences that real terminals
 * produce. Test fixtures strip ANSI when they care about plain text.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "council-test-home-"));
process.env["COUNCIL_HOME"] = TEST_HOME;

const TEST_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "council-test-data-"));
process.env["COUNCIL_DATA_HOME"] = TEST_DATA_HOME;

if (process.env["FORCE_COLOR"] === undefined) {
  process.env["FORCE_COLOR"] = "3";
}

process.on("exit", () => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.rmSync(TEST_DATA_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * `council doctor` — diagnose the local Council setup.
 *
 * Verifies prerequisites that must hold for `council convene` to work:
 *   - Node.js 20+ (basic runtime check)
 *   - Council home directory exists (or can be created)
 *   - SQLite database is openable (creates a temp DB to confirm)
 *   - @github/copilot-sdk is importable (presence check)
 *   - Available disk space sanity check
 *
 * Each check has a status (pass / fail / warn) and a remediation hint.
 * Exits 0 if all checks pass; exits 1 if any check fails so CI scripts
 * can use this as a smoke test.
 *
 * Authentication check (`copilot auth login` status) is intentionally
 * deferred — it requires invoking the Copilot CLI which has side effects.
 * Tracked as a follow-up issue.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";

import { defaultWriter, type Writer } from "./writer.js";

interface CheckResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly detail: string;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    return { name: "Node.js version", status: "pass", detail: `v${process.versions.node} (>= 20 required)` };
  }
  return {
    name: "Node.js version",
    status: "fail",
    detail: `v${process.versions.node} is too old; Council requires Node.js 20 or newer`,
  };
}

async function checkCouncilHome(): Promise<CheckResult> {
  const home = getCouncilHome();
  try {
    await fs.mkdir(home, { recursive: true });
    return { name: "Council home", status: "pass", detail: home };
  } catch (err: unknown) {
    return {
      name: "Council home",
      status: "fail",
      detail: `cannot create ${home}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkSqlite(): Promise<CheckResult> {
  // Try opening an in-memory libsql DB. If this fails, the WASM bundle
  // is broken or the runtime can't load it.
  try {
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: ":memory:" });
    await c.execute("SELECT 1");
    c.close();
    return { name: "SQLite (libsql)", status: "pass", detail: "in-memory DB OK" };
  } catch (err: unknown) {
    return {
      name: "SQLite (libsql)",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkCopilotSdk(): Promise<CheckResult> {
  try {
    const sdk = (await import("@github/copilot-sdk")) as Record<string, unknown>;
    if (typeof sdk["CopilotClient"] === "function") {
      return { name: "Copilot SDK", status: "pass", detail: "@github/copilot-sdk loaded" };
    }
    return { name: "Copilot SDK", status: "warn", detail: "loaded but CopilotClient export missing — version mismatch?" };
  } catch (err: unknown) {
    return {
      name: "Copilot SDK",
      status: "fail",
      detail: `cannot import @github/copilot-sdk: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkDiskSpace(): Promise<CheckResult> {
  // Cheap check: write a small file under the council home to ensure FS is writable.
  const home = getCouncilHome();
  const testFile = path.join(home, ".doctor-write-test");
  try {
    await fs.writeFile(testFile, "ok", "utf-8");
    await fs.unlink(testFile);
    return { name: "Disk write", status: "pass", detail: `${home} is writable` };
  } catch (err: unknown) {
    return {
      name: "Disk write",
      status: "fail",
      detail: `cannot write under ${home}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function statusIcon(status: CheckResult["status"]): string {
  switch (status) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "warn":
      return "⚠️";
  }
}

export function buildDoctorCommand(write: Writer = defaultWriter): Command {
  const cmd = new Command("doctor");
  cmd
    .description("Diagnose Council setup (Node, libsql, Copilot SDK, disk)")
    .action(async () => {
      const checks: readonly (() => Promise<CheckResult>)[] = [
        checkNodeVersion,
        checkCouncilHome,
        checkSqlite,
        checkCopilotSdk,
        checkDiskSpace,
      ];

      write("Council Doctor\n");
      write("═".repeat(40) + "\n");
      write(`Platform: ${os.platform()} ${os.arch()}\n`);
      write("\n");

      let allPassed = true;
      for (const run of checks) {
        const result = await run();
        if (result.status === "fail") allPassed = false;
        write(`${statusIcon(result.status)} ${result.name}\n   ${result.detail}\n`);
      }

      write("\n");
      if (allPassed) {
        write("All checks passed. Council is ready to convene.\n");
      } else {
        write("Some checks failed. See output above for remediation.\n");
        cmd.error("doctor checks failed", { exitCode: 1, code: "council.doctor.failed" });
      }
    });
  return cmd;
}

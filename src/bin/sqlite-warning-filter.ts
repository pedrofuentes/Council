const SQLITE_EXPERIMENTAL_WARNING_RE =
  /^SQLite is an experimental feature and might change at any time\.?$/i;

type EmitWarning = typeof process.emitWarning;

interface WarningEmitterProcess {
  emitWarning: EmitWarning;
}

const installedProcesses = new WeakSet<WarningEmitterProcess>();

function isExperimentalWarning(warning: string | Error, typeArg: unknown): boolean {
  return typeArg === "ExperimentalWarning" ||
    (warning instanceof Error && warning.name === "ExperimentalWarning");
}

function isNodeSqliteExperimentalWarning(warning: string | Error, typeArg: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  return isExperimentalWarning(warning, typeArg) && SQLITE_EXPERIMENTAL_WARNING_RE.test(message);
}

export function installSqliteExperimentalWarningFilter(
  warningProcess: WarningEmitterProcess = process,
): void {
  if (installedProcesses.has(warningProcess)) {
    return;
  }

  const originalEmitWarning = warningProcess.emitWarning;
  warningProcess.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    if (isNodeSqliteExperimentalWarning(warning, args[0])) {
      return;
    }

    Reflect.apply(originalEmitWarning as unknown as (...parameters: unknown[]) => void, warningProcess, [
      warning,
      ...args,
    ]);
  }) as EmitWarning;

  installedProcesses.add(warningProcess);
}

// Self-install on the current process as a module-load side effect so the
// filter is active before any sibling import (e.g. `@libsql/client`,
// `node:sqlite`) can emit Node's SQLite ExperimentalWarning. Idempotent via
// the `installedProcesses` WeakSet above — an explicit call from the entry
// point becomes a no-op. F02.
installSqliteExperimentalWarningFilter();

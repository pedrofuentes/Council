const SQLITE_EXPERIMENTAL_WARNING_RE =
  /^SQLite is an experimental feature and might change at any time\.?$/i;

interface WarningEmitterProcess {
  emitWarning: (warning: string | Error, ...args: unknown[]) => void;
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
  warningProcess.emitWarning = function filteredEmitWarning(
    warning: string | Error,
    ...args: unknown[]
  ): void {
    if (isNodeSqliteExperimentalWarning(warning, args[0])) {
      return;
    }

    Reflect.apply(originalEmitWarning as (...parameters: unknown[]) => void, warningProcess, [
      warning,
      ...args,
    ]);
  };

  installedProcesses.add(warningProcess);
}

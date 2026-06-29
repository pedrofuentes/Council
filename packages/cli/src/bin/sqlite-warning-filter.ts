const SQLITE_EXPERIMENTAL_WARNING_RE =
  /^SQLite is an experimental feature and might change at any time\.?$/i;

// Matches the stderr line Node prints for the SQLite ExperimentalWarning,
// optionally prefixed with `[CLI subprocess] ` when forwarded by
// `@github/copilot-sdk`. The SDK spawns the Copilot CLI as a Node.js child
// process, reads its stderr line-by-line, and re-writes each line with the
// `[CLI subprocess] ` prefix via `process.stderr.write` in the parent. The
// warning never reaches our `process.emitWarning` because it originates in
// a different process — we must filter it on stderr instead. See
// node_modules/@github/copilot-sdk/dist/client.js (search "CLI subprocess").
const SQLITE_EXPERIMENTAL_WARNING_STDERR_LINE_RE =
  /^(?:\[CLI subprocess\] )?\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\.?\r?\n?/gm;

// Companion hint Node prints right after any ExperimentalWarning. We only
// suppress it when it immediately follows a suppressed SQLite warning so
// unrelated ExperimentalWarnings keep their hint. The executable token is
// derived by Node from `process.argv0`; the @github/copilot-sdk subprocess
// inherits the parent's `process.execPath`, so on Windows the token may be
// `node.exe` / `node.EXE` (or another case variant) instead of bare `node`.
// Match any non-space token there so the footer is dropped on every platform —
// otherwise the message line is filtered but its footer leaks alone (PM-05).
const TRACE_WARNINGS_HINT_LINE_RE =
  /^(?:\[CLI subprocess\] )?\(Use `[^\s`]+ --trace-warnings \.\.\.` to show where the warning was created\)\r?\n?/m;

type EmitWarning = typeof process.emitWarning;

interface WarningEmitterProcess {
  emitWarning: EmitWarning;
}

type StderrWriteCallback = (error?: Error | null) => void;

interface StderrWritable {
  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | StderrWriteCallback,
    cb?: StderrWriteCallback,
  ): boolean;
}

interface StderrFilterState {
  expectTraceHint: boolean;
}

const installedProcesses = new WeakSet<WarningEmitterProcess>();
const installedStderrStreams = new WeakSet<StderrWritable>();

function isExperimentalWarning(warning: string | Error, typeArg: unknown): boolean {
  return (
    typeArg === "ExperimentalWarning" ||
    (warning instanceof Error && warning.name === "ExperimentalWarning")
  );
}

// `process.emitWarning` accepts the warning type either as the bare `type`
// string argument (`emitWarning(msg, "ExperimentalWarning")`) or via the
// options-object overload (`emitWarning(msg, { type: "ExperimentalWarning" })`).
// Normalize both so suppression matches Node's full overload contract.
function resolveWarningType(secondArg: unknown): unknown {
  if (typeof secondArg === "object" && secondArg !== null && "type" in secondArg) {
    return (secondArg as { type?: unknown }).type;
  }
  return secondArg;
}

function isNodeSqliteExperimentalWarning(warning: string | Error, typeArg: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  return isExperimentalWarning(warning, typeArg) && SQLITE_EXPERIMENTAL_WARNING_RE.test(message);
}

function filterStderrChunk(text: string, state: StderrFilterState): string {
  let result = text;
  let droppedSqlite = false;

  result = result.replace(SQLITE_EXPERIMENTAL_WARNING_STDERR_LINE_RE, () => {
    droppedSqlite = true;
    return "";
  });

  if (droppedSqlite || state.expectTraceHint) {
    const afterHintDrop = result.replace(TRACE_WARNINGS_HINT_LINE_RE, "");
    if (afterHintDrop !== result) {
      result = afterHintDrop;
      state.expectTraceHint = false;
    } else if (droppedSqlite) {
      // Hint may arrive in a subsequent write — carry the flag forward.
      state.expectTraceHint = true;
    } else if (/\S/.test(result)) {
      // Some other non-empty content arrived first — drop the carry-over.
      state.expectTraceHint = false;
    }
  }

  return result;
}

export function installSqliteExperimentalWarningStderrFilter(
  stream: StderrWritable = process.stderr,
): void {
  if (installedStderrStreams.has(stream)) {
    return;
  }

  const state: StderrFilterState = { expectTraceHint: false };
  const originalWrite = stream.write.bind(stream);

  stream.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | StderrWriteCallback,
    cb?: StderrWriteCallback,
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const filtered = filterStderrChunk(text, state);

    if (filtered === text) {
      return originalWrite(chunk, encoding as BufferEncoding | StderrWriteCallback | undefined, cb);
    }

    if (filtered.length === 0) {
      const callback = typeof encoding === "function" ? encoding : cb;
      if (callback !== undefined) {
        queueMicrotask(() => {
          callback(null);
        });
      }
      return true;
    }

    if (typeof chunk === "string") {
      return originalWrite(
        filtered,
        encoding as BufferEncoding | StderrWriteCallback | undefined,
        cb,
      );
    }

    // Binary chunk that contained the warning — re-emit the surviving text
    // portion as UTF-8 so we don't double-decode downstream consumers.
    return originalWrite(filtered, "utf8", typeof encoding === "function" ? encoding : cb);
  }) as StderrWritable["write"];

  installedStderrStreams.add(stream);
}

export function installSqliteExperimentalWarningFilter(
  warningProcess: WarningEmitterProcess = process,
  stderrStream: StderrWritable = process.stderr,
): void {
  installSqliteExperimentalWarningStderrFilter(stderrStream);

  if (installedProcesses.has(warningProcess)) {
    return;
  }

  const originalEmitWarning = warningProcess.emitWarning;
  warningProcess.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    if (isNodeSqliteExperimentalWarning(warning, resolveWarningType(args[0]))) {
      return;
    }

    // Forward through the original, type-preserving reference so its overloaded
    // signature is retained (no `as unknown as` erasure). Reflect.apply keeps
    // any later patcher's `this` binding intact.
    Reflect.apply(originalEmitWarning, warningProcess, [
      warning,
      ...args,
    ] as Parameters<EmitWarning>);
  }) as EmitWarning;

  installedProcesses.add(warningProcess);
}

/**
 * Shared CLI helpers — primarily the `Writer` injection pattern.
 *
 * Each command builder accepts an optional `Writer` parameter that
 * defaults to `process.stdout.write`. Tests can pass a string-capturing
 * writer to assert against output. This avoids reaching into Commander's
 * private OutputConfiguration internals.
 */

export type Writer = (s: string) => void;

export const defaultWriter: Writer = (s) => process.stdout.write(s);
export const defaultErrorWriter: Writer = (s) => process.stderr.write(s);

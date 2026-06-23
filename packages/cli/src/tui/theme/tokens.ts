import { Chalk } from "chalk";

export interface SemanticTheme {
  readonly accent: (s: string) => string;
  readonly muted: (s: string) => string;
  readonly error: (s: string) => string;
  readonly warn: (s: string) => string;
  readonly success: (s: string) => string;
  readonly enabled: boolean;
}

const identity = (s: string): string => s;

function colorDisabled(env: NodeJS.ProcessEnv): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return true;
  if (env["TERM"] === "dumb") return true;
  return false;
}

export function resolveTheme(env: NodeJS.ProcessEnv = process.env): SemanticTheme {
  if (colorDisabled(env)) {
    return { accent: identity, muted: identity, error: identity, warn: identity, success: identity, enabled: false };
  }
  const c = new Chalk({ level: 1 });
  return {
    accent: (s) => c.cyan(s),
    muted: (s) => c.dim(s),
    error: (s) => c.red(s),
    warn: (s) => c.yellow(s),
    success: (s) => c.green(s),
    enabled: true,
  };
}

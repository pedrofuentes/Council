import * as nodePath from "node:path";

export interface PathCompletion {
  readonly completed: string;
  readonly candidates: readonly string[];
}

export interface PathCompleteDeps {
  readonly readdir?: (dir: string) => Promise<readonly string[]>;
  readonly isDirectory?: (p: string) => Promise<boolean>;
}

async function defaultReaddir(dir: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

async function defaultIsDirectory(p: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function longestCommonPrefix(strs: readonly string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0] ?? "";
  for (let i = 1; i < strs.length; i += 1) {
    const s = strs[i] ?? "";
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) break;
  }
  return prefix;
}

export async function completePath(input: string, deps?: PathCompleteDeps): Promise<PathCompletion> {
  const readdirFn = deps?.readdir ?? defaultReaddir;
  const isDirectoryFn = deps?.isDirectory ?? defaultIsDirectory;

  const isEmpty = input.length === 0;
  const isAbsolute = !isEmpty && nodePath.isAbsolute(input);

  let dir: string;
  let partial: string;

  if (isEmpty) {
    dir = ".";
    partial = "";
  } else {
    const trailingSep = input.endsWith("/") || input.endsWith(nodePath.sep);
    const parsed = nodePath.parse(input);
    if (trailingSep) {
      dir = input.slice(0, -1) || ".";
      partial = "";
    } else {
      dir = parsed.dir || (isAbsolute ? "/" : ".");
      partial = parsed.base;
    }
  }

  let entries: readonly string[];
  try {
    entries = await readdirFn(dir);
  } catch {
    return { completed: input, candidates: [] };
  }

  const normalize = (entry: string): string => {
    if (dir === ".") return `./${entry}`;
    if (dir.endsWith("/")) return `${dir}${entry}`;
    return `${dir}/${entry}`;
  };

  const matched = entries.filter((e) => e.startsWith(partial));
  if (matched.length === 0) {
    return { completed: input, candidates: [] };
  }

  const candidates = matched.map(normalize);

  if (isEmpty) {
    return { completed: "./", candidates };
  }

  const candidateNames = matched.map((e) => normalize(e));
  const lcp = longestCommonPrefix(candidateNames);

  if (matched.length === 1) {
    const sole = normalize(matched[0] ?? "");
    const isDir = await isDirectoryFn(sole);
    if (isDir) {
      return { completed: `${sole}/`, candidates };
    }
    return { completed: sole, candidates };
  }

  return { completed: lcp, candidates };
}

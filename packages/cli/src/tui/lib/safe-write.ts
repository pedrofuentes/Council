import * as fs from "node:fs/promises";

/**
 * Write an exported file with no-overwrite, no-symlink-follow semantics.
 *
 * Export filenames are derived from a (user/model-controlled) panel name, so a
 * plain `fs.writeFile` could overwrite an existing file or follow a planted
 * symlink to clobber its target. The exclusive create flag (`wx` = `O_CREAT |
 * O_EXCL`) fails with `EEXIST` if the path already exists OR is a symlink,
 * closing both vectors; mode `0o600` keeps the exported transcript private.
 */
export async function writeFileExclusive(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

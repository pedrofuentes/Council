/**
 * Tests for the shared `--prompt-file` input channel helper.
 *
 * `readTextInput` reads a topic/question VERBATIM from either a file path
 * or standard input (when the source is `-`). It is the bulletproof
 * alternative to passing free-text topics as shell arguments, where the
 * shell may expand `$VAR`/`$180K`/backticks before Council ever sees argv.
 *
 * RED at this commit: src/cli/read-text-input.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTextInput } from "../../../src/cli/read-text-input.js";

describe("readTextInput", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-read-text-input-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  describe("file path source", () => {
    it("reads the file contents verbatim", async () => {
      const file = path.join(dir, "topic.txt");
      const content = "Should we raise $180K to fund the migration?";
      await fs.writeFile(file, content, "utf-8");

      const result = await readTextInput(file);

      expect(result).toBe(content);
    });

    it("preserves shell-sensitive characters and internal whitespace exactly", async () => {
      const file = path.join(dir, "tricky.txt");
      // Contains a $VAR, backticks, a bang, and an internal double space —
      // all of which a shell would mangle if passed as an argument.
      const content = "Compare `$PATH` vs $HOME  and the 50% gain!";
      await fs.writeFile(file, content, "utf-8");

      const result = await readTextInput(file);

      expect(result).toBe(content);
    });

    it("reads multi-line file contents verbatim", async () => {
      const file = path.join(dir, "multiline.txt");
      const content = "Line one\nLine two with $cost\nLine three";
      await fs.writeFile(file, content, "utf-8");

      const result = await readTextInput(file);

      expect(result).toBe(content);
    });
  });

  describe("stdin source (-)", () => {
    it("reads from the injected stdin reader when source is '-'", async () => {
      const result = await readTextInput("-", {
        readStdin: async () => "piped $topic from stdin",
      });

      expect(result).toBe("piped $topic from stdin");
    });

    it("returns stdin content verbatim including internal double spaces", async () => {
      const result = await readTextInput("-", {
        readStdin: async () => "a  b  c",
      });

      expect(result).toBe("a  b  c");
    });
  });

  describe("missing file", () => {
    it("throws a clear error naming the missing path", async () => {
      const missing = path.join(dir, "does-not-exist.txt");

      await expect(readTextInput(missing)).rejects.toThrow(/not found/i);
      await expect(readTextInput(missing)).rejects.toThrow(
        new RegExp(missing.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
      );
    });

    it("does not treat a missing-file error as stdin", async () => {
      const missing = path.join(dir, "nope.txt");
      let stdinCalled = false;

      await expect(
        readTextInput(missing, {
          readStdin: async () => {
            stdinCalled = true;
            return "";
          },
        }),
      ).rejects.toThrow(/not found/i);
      expect(stdinCalled).toBe(false);
    });
  });
});

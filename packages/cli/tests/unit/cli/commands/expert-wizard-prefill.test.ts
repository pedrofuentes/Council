/**
 * Tests for `council expert create` wizard pre-fill feedback (T7).
 *
 * When the user provides some — but not all — required fields via CLI flags,
 * the interactive wizard should acknowledge which fields were accepted from
 * the command line by listing them with a ✓ marker before prompting for the
 * remaining fields.
 *
 * These tests cover:
 *   (a) the pure formatter that produces the ✓ block
 *   (b) the full pre-fill path still skips the wizard entirely (no header,
 *       no ✓ lines)
 *   (c) the zero pre-fill path produces no ✓ lines from the formatter
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildExpertCommand,
  formatPrefilledLines,
  type CreateOptions,
} from "../../../../src/cli/commands/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

// Control / C1 / bidi / line-separator code points that must never reach a
// single-line terminal sink. Mirrors the class stripped by
// `toSingleLineDisplay`.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-prefill-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-expert-prefill-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

describe("expert create wizard pre-fill UX (T7)", () => {
  describe("formatPrefilledLines", () => {
    it("returns ✓ lines only for fields that were provided (partial pre-fill)", () => {
      const opts: CreateOptions = { slug: "mybot", name: "My Bot" };
      const out = formatPrefilledLines(opts);
      expect(out).toContain("✓ slug: mybot");
      expect(out).toContain("✓ displayName: My Bot");
      // Fields not provided must not appear.
      expect(out).not.toMatch(/role:/);
      expect(out).not.toMatch(/expertise:/);
      expect(out).not.toMatch(/stance:/);
      expect(out).not.toMatch(/personality:/);
      expect(out).not.toMatch(/personaDescription:/);
      // Trailing blank line separates the block from the next prompt.
      expect(out.endsWith("\n\n")).toBe(true);
    });

    it("returns the empty string when no fields are pre-filled (zero pre-fill)", () => {
      expect(formatPrefilledLines({})).toBe("");
    });

    it("sanitizes control, ANSI, and bidi bytes in echoed field values (injection-safe)", () => {
      // The pre-fill echo replays CLI-flag values (untrusted) back to the
      // terminal. A display name carrying a CR, LF, ANSI CSI sequences and a
      // bidi override must not inject extra ✓ lines or emit escape sequences.
      const evilName = "Bad\r\n\x1b[31mFAKE\x1b[0m\u202Ename";
      const out = formatPrefilledLines({ slug: "mybot", name: evilName });

      // No untrusted control / C1 / bidi / line-separator byte reaches the TTY.
      for (const line of out.split("\n")) {
        expect(line).not.toMatch(FORBIDDEN_DISPLAY_CHARS);
      }
      // The untrusted name cannot inject extra ✓ lines: slug + displayName only.
      expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
      // Visible characters preserved; control/ANSI/bidi collapsed to one line.
      expect(out).toContain("✓ displayName: Bad FAKEname");
    });

    it("includes every provided field, including optional ones", () => {
      const out = formatPrefilledLines({
        slug: "x",
        name: "X Name",
        role: "Role",
        expertise: "a,b",
        stance: "neutral",
        personality: "calm",
        personaDescription: "VP Eng",
      });
      for (const label of [
        "✓ slug: x",
        "✓ displayName: X Name",
        "✓ role: Role",
        "✓ expertise: a,b",
        "✓ stance: neutral",
        "✓ personality: calm",
        "✓ personaDescription: VP Eng",
      ]) {
        expect(out).toContain(label);
      }
    });

    it("preserves a stable field display order (slug → displayName → role → expertise → stance → personality → personaDescription)", () => {
      const out = formatPrefilledLines({
        slug: "s",
        name: "n",
        role: "r",
        expertise: "e",
        stance: "st",
        personality: "p",
        personaDescription: "pd",
      });
      const order = [
        out.indexOf("slug:"),
        out.indexOf("displayName:"),
        out.indexOf("role:"),
        out.indexOf("expertise:"),
        out.indexOf("stance:"),
        out.indexOf("personality:"),
        out.indexOf("personaDescription:"),
      ];
      for (let i = 1; i < order.length; i++) {
        const prev = order[i - 1];
        const curr = order[i];
        expect(curr).toBeGreaterThan(prev as number);
      }
    });
  });

  describe("full pre-fill via CLI flags", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("skips the wizard entirely (no 'Creating a new expert' header, no ✓ lines)", async () => {
      let captured = "";
      const cmd = buildExpertCommand((s) => {
        captured += s;
      });
      await cmd.parseAsync([
        "node",
        "expert",
        "create",
        "--slug",
        "fullbot",
        "--name",
        "Full Bot",
        "--role",
        "Tester",
        "--expertise",
        "x,y",
        "--stance",
        "neutral",
      ]);
      expect(captured).not.toContain("Creating a new expert");
      expect(captured).not.toMatch(/✓ slug:/);
      // The success line still fires:
      expect(captured).toMatch(/Expert "fullbot" created/);
    });
  });
});

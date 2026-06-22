"use strict";

// Fuzz target for the terminal-output sanitizer in
// packages/cli/src/cli/strip-control-chars.ts.
//
// stripControlChars() / toSingleLineDisplay() are the last line of defence
// before LLM-authored text (panel names, expert display names, roles, topics)
// is written to the user's TTY. A miss lets an attacker smuggle ANSI/OSC
// escapes, C1 controls, bidi-override (Trojan Source), or zero-width
// characters onto the terminal — spoofing prompts, exfiltrating via OSC 8
// hyperlinks, or visually reordering text. Both functions are PURE and are
// documented to never throw on arbitrary input, which makes them an ideal
// fuzz surface.
//
// This file is CommonJS (see .clusterfuzzlite/package.json `"type":
// "commonjs"`) so it can `require("@jazzer.js/core")` under the OSS-Fuzz
// JavaScript launcher. The sanitizer ships as ESM, so it is loaded once via a
// cached dynamic import of the transpiled output in packages/cli/dist-fuzz/
// (emitted by .clusterfuzzlite/tsconfig.fuzz.json).
const { FuzzedDataProvider } = require("@jazzer.js/core");

let mod;
const load = () => (mod ||= import("../packages/cli/dist-fuzz/strip-control-chars.js"));

// toSingleLineDisplay() promises the result always renders on ONE line, so no
// CR / LF / TAB or Unicode line/paragraph separator may survive.
const LINE_BREAK = /[\r\n\t\u2028\u2029]/;

/**
 * @param {Buffer} data - Fuzzer-provided bytes.
 */
module.exports.fuzz = async function fuzz(data) {
  const { stripControlChars, toSingleLineDisplay } = await load();
  const fdp = new FuzzedDataProvider(data);
  // Decode the bytes into an arbitrary JS string (may contain lone surrogates,
  // C0/C1 controls, bidi marks, etc.) — exactly the untrusted shape we sanitize.
  const text = fdp.consumeRemainingAsString();

  // Contract 1: never throws (no try/catch — any throw is a genuine finding)
  // and is idempotent. Re-sanitizing already-sanitized text must be a no-op;
  // if a second pass changes the string, a control sequence survived the
  // first pass (e.g. a nested/overlapping escape the regex failed to consume).
  const stripped = stripControlChars(text);
  if (stripControlChars(stripped) !== stripped) {
    throw new Error(
      "stripControlChars is not idempotent: a control sequence survived the first pass",
    );
  }

  // Contract 2: toSingleLineDisplay never throws and always collapses to a
  // single line. A surviving line break would let untrusted text inject extra
  // terminal lines or CR-overwrite a label to spoof a confirmation prompt.
  const oneLine = toSingleLineDisplay(text);
  if (LINE_BREAK.test(oneLine)) {
    throw new Error("toSingleLineDisplay left a line break in its output");
  }
};

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand, formatPanelSaveHint } from "../../../src/cli/commands/convene.js";
import { buildExpertCommand } from "../../../src/cli/commands/expert.js";
import { buildPanelCommand } from "../../../src/cli/commands/panel.js";
import { buildSessionsCommand } from "../../../src/cli/commands/sessions.js";
import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../src/memory/repositories/panel-library-repo.js";
import { PanelDocumentRepository } from "../../../src/memory/repositories/panel-document-repo.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";

const TEST_ROOT = path.join(process.cwd(), ".test-tmp", "single-line-terminal-sinks");

interface TestHome {
  readonly councilHome: string;
  readonly dataHome: string;
  readonly restore: () => void;
}

let previousCouncilHome: string | undefined;
let previousDataHome: string | undefined;
let testIndex = 0;

const malicious = "trusted\r\nINJECTED\u2028PARA\tTAB\x1B[31mRED\x1B[0m";
const singleLine = "trusted INJECTED PARA TABRED";

function expectNoInjectedLine(output: string): void {
  expect(output).not.toContain("\r");
  expect(output).not.toContain("\u2028");
  expect(output).not.toContain("\t");
  expect(output).not.toContain("\x1B[31m");
  expect(output).not.toContain("trusted\nINJECTED");
}

async function createTestHome(): Promise<TestHome> {
  testIndex += 1;
  const root = path.join(TEST_ROOT, `${process.pid}-${testIndex}`);
  const councilHome = path.join(root, "home");
  const dataHome = path.join(root, "data");
  await fs.mkdir(councilHome, { recursive: true });
  await fs.mkdir(dataHome, { recursive: true });
  process.env["COUNCIL_HOME"] = councilHome;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  return {
    councilHome,
    dataHome,
    restore: () => {
      if (previousCouncilHome === undefined) {
        delete process.env["COUNCIL_HOME"];
      } else {
        process.env["COUNCIL_HOME"] = previousCouncilHome;
      }
      if (previousDataHome === undefined) {
        delete process.env["COUNCIL_DATA_HOME"];
      } else {
        process.env["COUNCIL_DATA_HOME"] = previousDataHome;
      }
    },
  };
}

function sampleExpert(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: "Advisor",
    expertise: { weightedEvidence: ["tests"] },
    epistemicStance: "Evidence-led",
  };
}

async function openHomeDatabase(home: TestHome): Promise<CouncilDatabase> {
  return createDatabase(path.join(home.councilHome, "council.db"));
}

describe("single-line terminal sinks", () => {
  let home: TestHome;

  beforeEach(async () => {
    previousCouncilHome = process.env["COUNCIL_HOME"];
    previousDataHome = process.env["COUNCIL_DATA_HOME"];
    home = await createTestHome();
  });

  afterEach(async () => {
    home.restore();
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("collapses session names in the convene panel-save tip", () => {
    const output = formatPanelSaveHint(malicious);

    expect(output).toContain(`council panel save ${singleLine} [name]`);
    expectNoInjectedLine(output);
  });

  it("collapses session names in panel save success output", async () => {
    const db = await openHomeDatabase(home);
    try {
      const sessions = new PanelRepository(db);
      await sessions.create({
        name: malicious,
        topic: "stored topic",
        copilotHome: path.join(home.councilHome, "copilot"),
        configJson: JSON.stringify({
          definition: {
            name: "stored-panel",
            experts: [sampleExpert("stored-expert")],
          },
        }),
      });
    } finally {
      await db.destroy();
    }

    let output = "";
    const cmd = buildPanelCommand((message) => {
      output += message;
    });
    await cmd.parseAsync(["node", "panel", "save", malicious, "saved-panel"]);

    expect(output).toContain(`✓ Saved session "${singleLine}" as panel "saved-panel"`);
    expectNoInjectedLine(output);
  });

  it("collapses missing expert slugs in convene warnings", async () => {
    let errorOutput = "";
    const cmd = buildConveneCommand({
      writeError: (message) => {
        errorOutput += message;
      },
    });

    await expect(
      cmd.parseAsync(["node", "convene", "Should we proceed?", "--experts", malicious]),
    ).rejects.toThrow("--experts references experts not in the library");

    expect(errorOutput).toContain(`'${singleLine}'`);
    expectNoInjectedLine(errorOutput);
  });

  it("collapses panel names in expert delete warnings", async () => {
    const db = await openHomeDatabase(home);
    try {
      const library = new FileExpertLibrary(home.dataHome, db);
      await library.create(sampleExpert("victim"));
      const panels = new PanelLibraryRepository(db);
      await panels.create({
        name: malicious,
        description: null,
        yamlPath: path.join(home.dataHome, "panels", "malicious.yaml"),
        yamlChecksum: "checksum",
      });
      await panels.setMembers(malicious, ["victim"]);
    } finally {
      await db.destroy();
    }

    let output = "";
    const cmd = buildExpertCommand((message) => {
      output += message;
    });
    await cmd.parseAsync(["node", "expert", "delete", "victim", "--force", "--yes"]);

    expect(output).toContain(`Expert "victim" is used in 1 panel: ${singleLine}`);
    expect(output).toContain(`⚠ Panel "${singleLine}" now has 0 members`);
    expectNoInjectedLine(output);
  });

  it("collapses the untrusted panel name in the docs-list recovery hint (#1055/#1929)", async () => {
    // A panel whose name was populated out-of-band (migration/import/direct DB
    // edit) can carry control bytes that never pass `validatePanelName`. With a
    // linked folder but no indexed docs, the default `panel docs list <name>`
    // DB read (#1055) skips the name-validating `panelDocsDir` call and echoes
    // the name into a "run ... --refresh" recovery hint. That hint must be
    // collapsed to one display line so the untrusted name cannot smuggle
    // terminal control sequences. #1929.
    const linkDir = path.join(home.dataHome, "linked-docs");
    await fs.mkdir(linkDir, { recursive: true });
    const db = await openHomeDatabase(home);
    try {
      const panels = new PanelLibraryRepository(db);
      await panels.create({
        name: malicious,
        description: null,
        yamlPath: path.join(home.dataHome, "panels", "malicious.yaml"),
        yamlChecksum: "checksum",
      });
      const docs = new PanelDocumentRepository(db);
      await docs.addLinkedFolder(malicious, linkDir);
    } finally {
      await db.destroy();
    }

    let stdout = "";
    const cmd = buildPanelCommand(
      (message) => {
        stdout += message;
      },
      () => {
        /* stderr ignored — the plain DB-read path emits no warning */
      },
    );
    // No `--refresh`: the cheap default DB read (#1055). A linked folder with
    // zero indexed docs drives the recovery hint that echoes the panel name.
    await cmd.parseAsync(["node", "panel", "docs", "list", malicious]);

    // The hint echoes the panel name collapsed to a single display line.
    expect(stdout).toContain(`council panel docs list ${singleLine} --refresh`);
    expectNoInjectedLine(stdout);
    // Adversarial-byte guard on the surfaced hint line (split off the
    // inter-message "\n"): no C0/C1/DEL/bidi/line/para separators leak.
    const hintLine = stdout.split("\n").find((l) => l.includes("council panel docs list"));
    expect(hintLine).toBeDefined();
    // Codepoint scan covers the exact same ranges as
    // /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
    // without tripping ESLint's no-control-regex.
    const leakedControl = [...(hintLine ?? "")].some((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return (
        c <= 0x1f ||
        (c >= 0x7f && c <= 0x9f) ||
        c === 0x2028 ||
        c === 0x2029 ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
      );
    });
    expect(leakedControl).toBe(false);
  });

  it("collapses session list rows to one line per untrusted field", async () => {
    const db = await openHomeDatabase(home);
    try {
      const sessions = new PanelRepository(db);
      await sessions.create({
        name: malicious,
        topic: malicious,
        copilotHome: path.join(home.councilHome, "copilot"),
        configJson: JSON.stringify({ template: malicious }),
      });
    } finally {
      await db.destroy();
    }

    let output = "";
    const cmd = buildSessionsCommand({
      write: (message) => {
        output += message;
      },
    });
    await cmd.parseAsync(["node", "sessions"]);

    expect(output).toContain(`${singleLine} — ${singleLine}`);
    expect(output).toContain(`panel: ${singleLine}`);
    expect(output).toContain(`resume/export: ${singleLine}`);
    expectNoInjectedLine(output);
  });
});

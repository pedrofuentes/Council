import { describe, expect, it } from "vitest";

import { buildProgram } from "@council-ai/cli";

import { buildCommandModel } from "../../src/lib/reference/command-model";
import { GENERATED_FILE_WARNING, renderReference } from "../../src/lib/reference/render";

// These tests pin the command-reference generator to the REAL Commander
// program built by @council-ai/cli. They are the drift guard's first line of
// defence: if a command's name, description, arguments, options, or nesting
// changes in the CLI, the captured model — and therefore these assertions —
// change with it.
describe("buildCommandModel", () => {
  const root = buildCommandModel(buildProgram());

  it("captures the root program and its subcommands", () => {
    expect(root.name).toBe("council");
    expect(root.commandPath).toBe("council");
    expect(root.subcommands.length).toBeGreaterThan(0);
  });

  it("captures the top-level `convene` command with its description and topic argument", () => {
    const convene = root.subcommands.find((command) => command.name === "convene");

    expect(convene).toBeDefined();
    expect(convene?.commandPath).toBe("council convene");
    expect(convene?.description).toContain("Run a panel debate");
    expect(convene?.arguments.map((argument) => argument.display)).toContain("[topic]");
  });

  it("captures convene options including --template, --panel and --engine with choices", () => {
    const convene = root.subcommands.find((command) => command.name === "convene");
    const longFlags = convene?.options.map((option) => option.long) ?? [];

    expect(longFlags).toEqual(expect.arrayContaining(["--template", "--panel", "--engine"]));

    const engine = convene?.options.find((option) => option.long === "--engine");
    expect(engine?.choices).toEqual(expect.arrayContaining(["mock", "copilot"]));
  });

  it("captures nested subcommands (council panel create) and the chat command", () => {
    const panel = root.subcommands.find((command) => command.name === "panel");
    expect(panel).toBeDefined();

    const create = panel?.subcommands.find((command) => command.name === "create");
    expect(create).toBeDefined();
    expect(create?.commandPath).toBe("council panel create");

    const chat = root.subcommands.find((command) => command.name === "chat");
    expect(chat).toBeDefined();
    expect(chat?.arguments.map((argument) => argument.display)).toContain("[target]");
  });
});

describe("renderReference", () => {
  const files = renderReference(buildCommandModel(buildProgram()));
  const byPath = new Map(files.map((file) => [file.path, file.contents] as const));

  it("emits one markdown page per top-level command plus an index and JSON", () => {
    expect(byPath.has("src/content/docs/reference/commands/index.md")).toBe(true);
    expect(byPath.has("src/content/docs/reference/commands/convene.md")).toBe(true);
    expect(byPath.has("src/content/docs/reference/commands/panel.md")).toBe(true);
    expect(byPath.has("src/generated/commands.json")).toBe(true);
  });

  it("marks every generated file as do-not-edit", () => {
    for (const [, contents] of byPath) {
      expect(contents).toContain(GENERATED_FILE_WARNING);
    }
  });

  it("documents the convene command and its options on its page", () => {
    const convene = byPath.get("src/content/docs/reference/commands/convene.md");

    expect(convene).toContain("council convene");
    expect(convene).toContain("--template");
    expect(convene).toContain("[topic]");
  });

  it("documents nested subcommands within the top-level command page", () => {
    const panel = byPath.get("src/content/docs/reference/commands/panel.md");

    expect(panel).toContain("council panel create");
  });

  it("serialises the full command tree to commands.json", () => {
    const json = byPath.get("src/generated/commands.json");
    expect(json).toBeDefined();

    const parsed = JSON.parse(json ?? "{}") as { command: { name: string } };
    expect(parsed.command.name).toBe("council");
  });
});

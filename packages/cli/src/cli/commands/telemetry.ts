/**
 * `council telemetry status|enable|disable|explain` — telemetry management.
 */
import { Command } from "commander";

import { loadConfig, updateConfigField } from "../../config/index.js";

import { defaultWriter, type Writer } from "./writer.js";

export interface TelemetryDeps {
  readonly write?: Writer;
}

export function buildTelemetryCommand(deps: TelemetryDeps = {}): Command {
  const write = deps.write ?? defaultWriter;

  const telemetry = new Command("telemetry");
  telemetry.description("Manage telemetry settings");

  telemetry
    .command("status")
    .description("Show current telemetry status")
    .action(async () => {
      const config = await loadConfig();
      const status = config.telemetry.enabled ? "enabled" : "disabled";
      write(`Telemetry is ${status}\n`);
    });

  telemetry
    .command("enable")
    .description("Enable telemetry collection")
    .action(async () => {
      await updateConfigField("telemetry.enabled", true);
      write("Telemetry enabled\n");
    });

  telemetry
    .command("disable")
    .description("Disable telemetry collection")
    .action(async () => {
      await updateConfigField("telemetry.enabled", false);
      write("Telemetry disabled\n");
    });

  telemetry
    .command("explain")
    .description("Explain what telemetry collects")
    .action(async () => {
      write(
        `Council telemetry is opt-in and content-free.\n\n` +
          `When enabled, Council collects:\n` +
          `  ALLOWED:\n` +
          `    • Command names (e.g., "convene", "ask")\n` +
          `    • Application version\n` +
          `    • Operating system family (e.g., "darwin", "linux", "win32")\n` +
          `    • Exit status class (success, error, cancelled)\n\n` +
          `  FORBIDDEN:\n` +
          `    • Prompts, questions, or expert responses (no content)\n` +
          `    • File paths or directory names\n` +
          `    • Usernames or tokens\n` +
          `    • Any personally identifiable information\n\n` +
          `Telemetry is disabled by default. No outbound collection sink is\n` +
          `enabled yet. Use \`council telemetry enable\` to opt in.\n\n` +
          `For full details, see PRIVACY.md and docs/TELEMETRY.md in the\n` +
          `Council repository.\n`,
      );
    });

  return telemetry;
}

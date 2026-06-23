export type SettingsFieldKind = "string" | "number" | "boolean" | "enum";

export interface SettingsFieldDescriptor {
  readonly path: string;
  readonly section: string;
  readonly label: string;
  readonly kind: SettingsFieldKind;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly options?: readonly string[];
  readonly optional?: boolean;
}

export interface SettingsFieldState extends SettingsFieldDescriptor {
  readonly value: string;
}

export type ValidateResult =
  | { readonly ok: true; readonly value: string | number | boolean }
  | { readonly ok: false; readonly error: string };

export interface SettingsDataSource {
  readonly load: () => Promise<readonly SettingsFieldState[]>;
  readonly save: (
    changes: readonly { readonly path: string; readonly value: string | number | boolean }[],
  ) => Promise<void>;
}

export const SETTINGS_FIELDS: readonly SettingsFieldDescriptor[] = [
  { path: "defaults.model", section: "Defaults", label: "Default model", kind: "string" },
  {
    path: "defaults.engine",
    section: "Defaults",
    label: "Engine",
    kind: "enum",
    options: ["copilot", "mock", "openai", "anthropic"],
  },
  {
    path: "defaults.maxRounds",
    section: "Defaults",
    label: "Max rounds",
    kind: "number",
    integer: true,
    min: 1,
    max: 20,
  },
  {
    path: "defaults.maxExperts",
    section: "Defaults",
    label: "Max experts",
    kind: "number",
    integer: true,
    min: 2,
    max: 8,
  },
  {
    path: "defaults.maxWordsPerResponse",
    section: "Defaults",
    label: "Max words/response",
    kind: "number",
    integer: true,
    min: 50,
    max: 2000,
  },
  { path: "telemetry.enabled", section: "Telemetry", label: "Telemetry enabled", kind: "boolean" },
  {
    path: "providers.openai.apiKeyEnvVar",
    section: "Providers",
    label: "OpenAI API key env var",
    kind: "string",
    optional: true,
  },
  {
    path: "providers.anthropic.apiKeyEnvVar",
    section: "Providers",
    label: "Anthropic API key env var",
    kind: "string",
    optional: true,
  },
  {
    path: "expert.recencyHalfLifeDays",
    section: "Expert",
    label: "Memory recency half-life (days)",
    kind: "number",
    integer: true,
    min: 1,
    max: 365,
  },
  {
    path: "documents.aiExtraction",
    section: "Documents",
    label: "AI extraction",
    kind: "enum",
    options: ["off", "ask", "auto"],
  },
  {
    path: "documents.maxFileSizeMB",
    section: "Documents",
    label: "Max file size (MB)",
    kind: "number",
    min: 1,
    max: 500,
  },
  {
    path: "chat.recentTurnCount",
    section: "Chat",
    label: "Recent turns kept",
    kind: "number",
    integer: true,
    min: 5,
    max: 50,
  },
  {
    path: "chat.summaryMaxWords",
    section: "Chat",
    label: "Summary max words",
    kind: "number",
    integer: true,
    min: 100,
    max: 2000,
  },
  {
    path: "chat.longConversationWarning",
    section: "Chat",
    label: "Long-conversation warning",
    kind: "number",
    integer: true,
    min: 50,
    max: 10000,
  },
  {
    path: "conclude.maxTranscriptChars",
    section: "Conclude",
    label: "Max transcript chars",
    kind: "number",
    min: 1000,
    max: 1000000,
  },
  {
    path: "qualityGate.mode",
    section: "Quality Gate",
    label: "Mode",
    kind: "enum",
    options: ["off", "warn", "regenerate"],
  },
  {
    path: "qualityGate.maxRegenerations",
    section: "Quality Gate",
    label: "Max regenerations",
    kind: "number",
    integer: true,
    min: 0,
    max: 3,
  },
  { path: "paths.dataHome", section: "Paths", label: "Data home", kind: "string" },
];

export function readFieldValue(config: unknown, path: string): string {
  let current: unknown = config;

  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return "";
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (current === undefined || current === null) {
    return "";
  }

  if (typeof current === "boolean") {
    return current ? "true" : "false";
  }

  if (typeof current === "number") {
    return String(current);
  }

  if (typeof current === "string") {
    return current;
  }

  return "";
}

export function validateField(field: SettingsFieldDescriptor, raw: string): ValidateResult {
  if (field.kind === "string") {
    const v = raw.trim();
    if (v === "" && field.optional !== true) {
      return { ok: false, error: "Required" };
    }
    if (hasControlCharacter(v)) {
      return { ok: false, error: "No control characters" };
    }
    return { ok: true, value: v };
  }

  if (field.kind === "number") {
    const n = parseNumberField(field, raw);
    if (typeof n === "string") {
      return { ok: false, error: n };
    }
    const min = Number(field.min);
    const max = Number(field.max);
    if (n < min || n > max) {
      return { ok: false, error: `Must be between ${field.min} and ${field.max}` };
    }
    return { ok: true, value: n };
  }

  if (field.kind === "boolean") {
    const t = raw.trim().toLowerCase();
    if (["true", "yes", "y", "on", "1"].includes(t)) {
      return { ok: true, value: true };
    }
    if (["false", "no", "n", "off", "0"].includes(t)) {
      return { ok: true, value: false };
    }
    return { ok: false, error: "Must be true or false" };
  }

  const t = raw.trim();
  if (field.options?.includes(t)) {
    return { ok: true, value: t };
  }
  return { ok: false, error: `Must be one of: ${field.options?.join(", ")}` };
}

export function buildSettingsFields(config: unknown): readonly SettingsFieldState[] {
  return SETTINGS_FIELDS.map((field) => ({ ...field, value: readFieldValue(config, field.path) }));
}

export function createSettingsDataSource(deps: {
  readonly loadConfig: () => Promise<unknown>;
  readonly updateConfigFields: (
    updates: readonly { readonly key: string; readonly value: string | number | boolean }[],
  ) => Promise<void>;
}): SettingsDataSource {
  return {
    load: async () => buildSettingsFields(await deps.loadConfig()),
    save: async (changes) =>
      deps.updateConfigFields(changes.map((change) => ({ key: change.path, value: change.value }))),
  };
}

function parseNumberField(field: SettingsFieldDescriptor, raw: string): number | string {
  if (field.integer === true) {
    if (!/^[+-]?[0-9]+$/.test(raw.trim())) {
      return "Must be a whole number";
    }
    return Number.parseInt(raw.trim(), 10);
  }

  const t = raw.trim();
  if (t === "") {
    return "Must be a number";
  }
  const n = Number(t);
  if (!Number.isFinite(n)) {
    return "Must be a number";
  }
  return n;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x1f) {
      return true;
    }
  }
  return false;
}

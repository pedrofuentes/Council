/**
 * libsql + Kysely persistence layer for Council.
 *
 * Per ADR-005 (DECISIONS.md), Council uses `@libsql/client` (pure WASM) +
 * `@libsql/kysely-libsql` so that `pnpm install` works on every Node version
 * without a native build step. The orchestration-index role from ADR-002
 * is unchanged: this DB owns metadata only; transcript bodies live in the
 * Copilot SDK's per-session store.
 *
 * Public API:
 *   createDatabase(path)  → connect, run pending migrations, return Kysely
 *   CouncilDatabase       → typed Kysely instance for repositories
 *   CouncilSchema         → table-row-shape interfaces (snake_case columns)
 *
 * `path` semantics:
 *   - ":memory:"          → in-memory DB (used by tests)
 *   - any other string    → treated as a filesystem path; libsql wraps it as `file:<path>`
 */
import { type Client, createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely } from "kysely";

// ---------- Schema row shapes ----------

export interface SchemaVersionRow {
  readonly version: number;
  readonly applied_at: string;
}

export interface PanelRow {
  readonly id: string;
  readonly name: string;
  readonly topic: string | null;
  readonly copilot_home: string;
  readonly config_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ExpertRow {
  readonly id: string;
  readonly panel_id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly model: string;
  readonly system_message: string;
  readonly copilot_session_id: string | null;
  readonly created_at: string;
  readonly extracted_memory_json: string | null;
}

export interface DebateRow {
  readonly id: string;
  readonly panel_id: string;
  readonly prompt: string;
  readonly status: string;
  readonly moderator: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly cost_estimate: number | null;
}

export interface TurnRow {
  readonly id: string;
  readonly debate_id: string;
  readonly round: number;
  readonly seq: number;
  readonly speaker_kind: string;
  readonly expert_id: string | null;
  readonly content: string;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly latency_ms: number | null;
  readonly created_at: string;
}

export interface ExpertLibraryRow {
  readonly slug: string;
  readonly kind: string;
  readonly display_name: string;
  readonly yaml_path: string;
  readonly yaml_checksum: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PanelLibraryRow {
  readonly name: string;
  readonly description: string | null;
  readonly yaml_path: string;
  readonly yaml_checksum: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PanelMemberRow {
  readonly panel_name: string;
  readonly expert_slug: string;
  readonly position: number;
  readonly created_at: string;
}

export interface ChatSessionRow {
  readonly id: string;
  readonly target_type: string;
  readonly target_slug: string;
  readonly status: string;
  readonly summary: string | null;
  readonly summary_through_seq: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChatTurnRow {
  readonly id: string;
  readonly chat_id: string;
  readonly seq: number;
  readonly role: string;
  readonly expert_slug: string | null;
  readonly content: string;
  readonly is_mention: number;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly created_at: string;
}

export interface ExpertDocumentRow {
  readonly id: string;
  readonly expert_slug: string;
  readonly file_path: string;
  readonly filename: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly word_count: number;
  readonly status: string;
  readonly processed_at: string | null;
  readonly created_at: string;
}

export interface PanelLinkedFolderRow {
  readonly id: string;
  readonly panel_name: string;
  readonly folder_path: string;
  readonly created_at: string;
}

export interface PanelDocumentRow {
  readonly id: string;
  readonly panel_name: string;
  readonly source: string;
  readonly file_path: string;
  readonly filename: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly word_count: number;
  readonly status: string;
  readonly processed_at: string | null;
  readonly created_at: string;
}

export interface PersonaProfileRow {
  readonly expert_slug: string;
  readonly communication_style: string;
  readonly decision_patterns: string;
  readonly biases: string;
  readonly vocabulary: string;
  readonly epistemic_stance: string;
  readonly document_count: number;
  readonly total_words: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CouncilSchema {
  schema_version: SchemaVersionRow;
  panels: PanelRow;
  experts: ExpertRow;
  debates: DebateRow;
  turns: TurnRow;
  expert_library: ExpertLibraryRow;
  panel_library: PanelLibraryRow;
  panel_members: PanelMemberRow;
  chat_sessions: ChatSessionRow;
  chat_turns: ChatTurnRow;
  expert_documents: ExpertDocumentRow;
  persona_profiles: PersonaProfileRow;
  panel_linked_folders: PanelLinkedFolderRow;
  panel_documents: PanelDocumentRow;
}

export type CouncilDatabase = Kysely<CouncilSchema>;

// ---------- Migration runner ----------

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

// Migrations are inlined as string literals so the bundled CLI (tsup
// single-file output) works without copying .sql files into dist/.
// The canonical .sql files remain in src/memory/migrations/ for
// readability and git-diffable history.

function loadMigrations(): readonly Migration[] {
  return [
    {
      version: 1,
      name: "001_init",
      sql: `\
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  topic        TEXT,
  copilot_home TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experts (
  id                  TEXT PRIMARY KEY,
  panel_id            TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  model               TEXT NOT NULL,
  system_message      TEXT NOT NULL,
  copilot_session_id  TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (panel_id, slug)
);

CREATE TABLE IF NOT EXISTS debates (
  id            TEXT PRIMARY KEY,
  panel_id      TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL,
  status        TEXT NOT NULL,
  moderator     TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  cost_estimate INTEGER
);

CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  debate_id    TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  speaker_kind TEXT NOT NULL,
  expert_id    TEXT REFERENCES experts(id) ON DELETE SET NULL,
  content      TEXT NOT NULL,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  latency_ms   INTEGER,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_debate_round_seq
  ON turns (debate_id, round, seq);

CREATE INDEX IF NOT EXISTS idx_experts_panel_id
  ON experts (panel_id);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content,
  content='turns',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;`,
    },
    {
      version: 2,
      name: "002_add_indexes",
      sql: `\
CREATE INDEX IF NOT EXISTS idx_panels_name ON panels(name);
CREATE INDEX IF NOT EXISTS idx_debates_panel_id ON debates(panel_id);`,
    },
    {
      version: 3,
      name: "003_expert_extracted_memory",
      sql: `ALTER TABLE experts ADD COLUMN extracted_memory_json TEXT;`,
    },
    {
      version: 4,
      name: "004_expert_library",
      sql: `\
CREATE TABLE IF NOT EXISTS expert_library (
  slug          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'generic',
  display_name  TEXT NOT NULL,
  yaml_path     TEXT NOT NULL,
  yaml_checksum TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_library (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  yaml_path     TEXT NOT NULL,
  yaml_checksum TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_members (
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  expert_slug  TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (panel_name, expert_slug)
);

CREATE INDEX IF NOT EXISTS idx_panel_members_expert
  ON panel_members (expert_slug);`,
    },
    {
      version: 5,
      name: "005_chat",
      sql: `\
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,
  target_type         TEXT NOT NULL,
  target_slug         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  summary             TEXT,
  summary_through_seq INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_target
  ON chat_sessions (target_type, target_slug, status);

CREATE TABLE IF NOT EXISTS chat_turns (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  expert_slug  TEXT,
  content      TEXT NOT NULL,
  is_mention   INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE (chat_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_chat_seq
  ON chat_turns (chat_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS chat_turns_fts USING fts5(
  content,
  content='chat_turns',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chat_turns_ai AFTER INSERT ON chat_turns BEGIN
  INSERT INTO chat_turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chat_turns_ad AFTER DELETE ON chat_turns BEGIN
  INSERT INTO chat_turns_fts(chat_turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;`,
    },
    {
      version: 6,
      name: "006_documents",
      sql: `\
CREATE TABLE IF NOT EXISTS expert_documents (
  id            TEXT PRIMARY KEY,
  expert_slug   TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  filename      TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  word_count    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  processed_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (expert_slug, file_path)
);

CREATE INDEX IF NOT EXISTS idx_expert_documents_slug
  ON expert_documents (expert_slug, status);`,
    },
    {
      version: 7,
      name: "007_document_index",
      sql: `\
CREATE VIRTUAL TABLE IF NOT EXISTS document_index USING fts5(
  content,
  source_type,
  source_slug,
  file_path,
  tokenize='porter unicode61'
);`,
    },
    {
      version: 8,
      name: "008_persona_profiles",
      sql: `\
CREATE TABLE IF NOT EXISTS persona_profiles (
  expert_slug         TEXT PRIMARY KEY REFERENCES expert_library(slug) ON DELETE CASCADE,
  communication_style TEXT NOT NULL,
  decision_patterns   TEXT NOT NULL,
  biases              TEXT NOT NULL,
  vocabulary          TEXT NOT NULL,
  epistemic_stance    TEXT NOT NULL,
  document_count      INTEGER NOT NULL DEFAULT 0,
  total_words         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);`,
    },
    {
      version: 9,
      name: "009_panel_documents",
      sql: `\
CREATE TABLE IF NOT EXISTS panel_linked_folders (
  id           TEXT PRIMARY KEY,
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (panel_name, folder_path)
);

CREATE TABLE IF NOT EXISTS panel_documents (
  id           TEXT PRIMARY KEY,
  panel_name   TEXT NOT NULL REFERENCES panel_library(name) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  filename     TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  word_count   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  processed_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (panel_name, file_path)
);

CREATE INDEX IF NOT EXISTS idx_panel_documents_panel
  ON panel_documents (panel_name, status);`,
    },
    {
      version: 10,
      name: "010_chat_active_unique",
      sql: `\
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active_unique
  ON chat_sessions (target_type, target_slug)
  WHERE status = 'active';`,
    },
  ];
}

/**
 * Split a SQL migration file into individual statements while keeping
 * `BEGIN ... END` trigger bodies intact. Used to feed libsql's
 * `executeMultiple` is not strictly necessary (it accepts the whole script),
 * but the splitter is exported for testability and for future per-statement
 * progress reporting.
 */
export function splitSqlStatements(sqlText: string): readonly string[] {
  const cleaned = sqlText
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .filter((line) => line.length > 0)
    .join("\n");

  const statements: string[] = [];
  let buffer = "";
  let depth = 0;
  const tokens = cleaned.split(/(\bBEGIN\b|\bEND\b|;)/i);
  for (const token of tokens) {
    if (token === ";") {
      buffer += ";";
      if (depth === 0) {
        const trimmed = buffer.trim();
        if (trimmed.length > 0 && trimmed !== ";") statements.push(trimmed);
        buffer = "";
      }
      continue;
    }
    if (/^BEGIN$/i.test(token)) depth += 1;
    else if (/^END$/i.test(token)) depth = Math.max(0, depth - 1);
    buffer += token;
  }
  if (buffer.trim().length > 0) statements.push(buffer.trim());
  return statements;
}

async function applyMigrations(client: Client, db: CouncilDatabase): Promise<void> {
  // Ensure schema_version exists so we can gate migrations before re-running them.
  // (The 001 migration also creates it via CREATE TABLE IF NOT EXISTS, so this is safe.)
  await client.executeMultiple(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const migrations = loadMigrations();
  for (const migration of migrations) {
    const existing = await db
      .selectFrom("schema_version")
      .select("version")
      .where("version", "=", migration.version)
      .executeTakeFirst();
    if (existing) continue;
    // Use the underlying libsql client's executeMultiple — it handles
    // multi-statement scripts including CREATE TRIGGER BEGIN/END blocks
    // that Kysely's sql.raw cannot.
    await client.executeMultiple(migration.sql);
    await db
      .insertInto("schema_version")
      .values({
        version: migration.version,
        applied_at: new Date().toISOString(),
      })
      .execute();
  }
}

// ---------- Public entry ----------

export async function createDatabase(dbPath: string): Promise<CouncilDatabase> {
  const url = dbPath === ":memory:" ? ":memory:" : `file:${dbPath}`;
  const client = createClient({ url });
  const dialect = new LibsqlDialect({ client });
  const db = new Kysely<CouncilSchema>({ dialect });
  await applyMigrations(client, db);
  return db;
}

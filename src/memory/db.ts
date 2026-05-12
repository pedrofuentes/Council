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
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
}

export type CouncilDatabase = Kysely<CouncilSchema>;

// ---------- Migration runner ----------

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

function loadMigrations(): readonly Migration[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.join(here, "migrations");
  return [
    {
      version: 1,
      name: "001_init",
      sql: readFileSync(path.join(migrationsDir, "001_init.sql"), "utf-8"),
    },
    {
      version: 2,
      name: "002_add_indexes",
      sql: readFileSync(path.join(migrationsDir, "002_add_indexes.sql"), "utf-8"),
    },
    {
      version: 3,
      name: "003_expert_extracted_memory",
      sql: readFileSync(path.join(migrationsDir, "003_expert_extracted_memory.sql"), "utf-8"),
    },
    {
      version: 4,
      name: "004_expert_library",
      sql: readFileSync(path.join(migrationsDir, "004_expert_library.sql"), "utf-8"),
    },
    {
      version: 5,
      name: "005_chat",
      sql: readFileSync(path.join(migrationsDir, "005_chat.sql"), "utf-8"),
    },
    {
      version: 6,
      name: "006_documents",
      sql: readFileSync(path.join(migrationsDir, "006_documents.sql"), "utf-8"),
    },
    {
      version: 7,
      name: "007_document_index",
      sql: readFileSync(path.join(migrationsDir, "007_document_index.sql"), "utf-8"),
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

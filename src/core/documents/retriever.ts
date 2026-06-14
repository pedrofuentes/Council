/**
 * Document content retriever (Roadmap 6.3).
 *
 * Queries the `document_index` FTS5 virtual table (migration 007) for
 * snippets relevant to a user message, supporting retrieval-augmented
 * generation in chat sessions.
 *
 * Ranking: results are ordered by FTS5's built-in BM25 (`rank` aux column,
 * negative — lower is better). We return `relevanceScore = -rank` so that
 * higher values are more relevant for callers.
 *
 * Query sanitization: user messages may contain FTS5 operators (`AND`,
 * `OR`, `NOT`, `NEAR`, parentheses, `*`, quotes, `^`). To avoid syntax
 * errors and surprising operator behavior we split on whitespace, strip
 * non-alphanumeric / non-letter characters from each token, wrap surviving
 * tokens in double quotes, and join with spaces (implicit AND). An empty
 * or all-noise query short-circuits to an empty result list.
 */
import { sql } from "kysely";

import type { CouncilDatabase } from "../../memory/db.js";
import type { DocumentSourceType } from "./indexer.js";

export interface DocumentSnippet {
  readonly source: string;
  readonly sourcePath: string;
  readonly content: string;
  readonly relevanceScore: number;
  /**
   * Optional human-readable label describing how the source document
   * was extracted (e.g. "built-in pdf parser", "AI fallback"). When
   * present, the chat prompt renders a provenance line so both the AI
   * and the user can reason about trustworthiness.
   */
  readonly extractionMethod?: string;
}

export type RetrieveSourceFilter = DocumentSourceType | "all";

export interface RetrieveOptions {
  readonly maxResults?: number;
  readonly sources?: RetrieveSourceFilter;
  readonly expertSlug?: string;
  readonly panelName?: string;
}

export interface DocumentRetriever {
  retrieve(query: string, options?: RetrieveOptions): Promise<readonly DocumentSnippet[]>;
}

interface SnippetRow {
  readonly source_type: string;
  readonly source_slug: string;
  readonly file_path: string;
  readonly excerpt: string;
  readonly rank: number;
}

const DEFAULT_MAX_RESULTS = 5;
const SNIPPET_TOKEN_COUNT = 32;

function sanitizeQuery(raw: string): string | null {
  if (!raw) return null;
  // Strip FTS5-significant punctuation; keep letters, digits, underscore, and
  // unicode word characters. Tokens become safe to wrap in double quotes.
  const tokens = raw
    .split(/\s+/)
    .map((tok) => tok.replace(/[^\p{L}\p{N}_]+/gu, ""))
    .filter((tok) => tok.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((tok) => `"${tok}"`).join(" ");
}

function basename(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

export function createDocumentRetriever(db: CouncilDatabase): DocumentRetriever {
  return {
    async retrieve(
      query: string,
      options: RetrieveOptions = {},
    ): Promise<readonly DocumentSnippet[]> {
      const ftsQuery = sanitizeQuery(query);
      if (ftsQuery === null) return [];

      const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
      const sources = options.sources ?? "all";

      // Build optional filter fragments. We compose with sql.join so the
      // resulting statement is one parameterised query, not string concat.
      const filters = [sql`document_index MATCH ${ftsQuery}`];
      if (sources !== "all") {
        filters.push(sql`source_type = ${sources}`);
      }
      if (options.expertSlug !== undefined) {
        filters.push(sql`source_type = ${"expert"}`);
        filters.push(sql`source_slug = ${options.expertSlug}`);
      }
      if (options.panelName !== undefined) {
        filters.push(sql`source_type = ${"panel"}`);
        filters.push(sql`source_slug = ${options.panelName}`);
      }
      const whereClause = sql.join(filters, sql` AND `);

      const result = await sql<SnippetRow>`
        SELECT
          source_type,
          source_slug,
          file_path,
          snippet(document_index, 0, '', '', '...', ${SNIPPET_TOKEN_COUNT}) AS excerpt,
          rank AS rank
        FROM document_index
        WHERE ${whereClause}
        ORDER BY rank
        LIMIT ${maxResults}
      `.execute(db);

      return result.rows.map((row) => ({
        source: basename(row.file_path),
        sourcePath: row.file_path,
        content: row.excerpt,
        relevanceScore: -row.rank,
      }));
    },
  };
}

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
 * non-alphanumeric / non-letter characters from each token, and wrap
 * surviving tokens in double quotes. Tokens are first combined with
 * implicit AND (precise); if that yields zero rows for a multi-token
 * query we retry with OR so a single non-matching token can't suppress
 * otherwise-relevant documents. An empty or all-noise query
 * short-circuits to an empty result list.
 */
import { sql, type RawBuilder } from "kysely";

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

/**
 * A single (source_type, slug) pair to constrain retrieval to. Multiple
 * scopes are OR-combined, so a query can target an expert's own documents
 * AND every panel the expert belongs to in one call (see
 * {@link buildExpertRetrievalScopes}). Scopes are ANDed with the FTS MATCH
 * and any other filters.
 */
export interface RetrieveScope {
  readonly sourceType: DocumentSourceType;
  readonly slug: string;
}

export interface RetrieveOptions {
  readonly maxResults?: number;
  readonly sources?: RetrieveSourceFilter;
  readonly expertSlug?: string;
  readonly panelName?: string;
  /**
   * OR-combined (source_type, slug) scopes. When provided, only documents
   * matching at least one scope are returned. Combine with the FTS MATCH
   * via AND. Empty array means "no scope constraint".
   */
  readonly scopes?: readonly RetrieveScope[];
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
// FTS5's snippet() caps the token window at 64; use the maximum so planted
// figures that sit deep inside a paragraph are not cropped out of the excerpt.
const SNIPPET_TOKEN_COUNT = 64;

/**
 * Split a raw user message into FTS-safe tokens. FTS5-significant
 * punctuation is stripped so each surviving token is safe to wrap in
 * double quotes; an empty / all-noise query yields an empty list.
 */
function tokenize(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((tok) => tok.replace(/[^\p{L}\p{N}_]+/gu, ""))
    .filter((tok) => tok.length > 0);
}

/** Join sanitized tokens into an FTS5 MATCH expression. */
function toMatchQuery(tokens: readonly string[], joiner: " " | " OR "): string {
  return tokens.map((tok) => `"${tok}"`).join(joiner);
}

function basename(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/**
 * Build the OR-combined retrieval scopes for a one-on-one expert chat:
 * the expert's own documents plus every panel the expert belongs to, so a
 * member sees the panel's shared docs even when talking to the expert
 * directly. The expert scope is always first.
 */
export function buildExpertRetrievalScopes(
  expertSlug: string,
  panelNames: readonly string[],
): readonly RetrieveScope[] {
  return [
    { sourceType: "expert", slug: expertSlug },
    ...panelNames.map((name) => ({ sourceType: "panel" as const, slug: name })),
  ];
}

export function createDocumentRetriever(db: CouncilDatabase): DocumentRetriever {
  return {
    async retrieve(
      query: string,
      options: RetrieveOptions = {},
    ): Promise<readonly DocumentSnippet[]> {
      const tokens = tokenize(query);
      if (tokens.length === 0) return [];

      const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
      const sources = options.sources ?? "all";

      // Static (non-MATCH) filters shared across the strict-AND attempt and
      // the OR fallback. Composed with sql.join so the statement stays a
      // single parameterised query, not string concatenation.
      const staticFilters: RawBuilder<unknown>[] = [];
      if (sources !== "all") {
        staticFilters.push(sql`source_type = ${sources}`);
      }
      if (options.expertSlug !== undefined) {
        staticFilters.push(sql`source_type = ${"expert"}`);
        staticFilters.push(sql`source_slug = ${options.expertSlug}`);
      }
      if (options.panelName !== undefined) {
        staticFilters.push(sql`source_type = ${"panel"}`);
        staticFilters.push(sql`source_slug = ${options.panelName}`);
      }
      if (options.scopes !== undefined && options.scopes.length > 0) {
        const scopeClauses = options.scopes.map(
          (scope) =>
            sql`(source_type = ${scope.sourceType} AND source_slug = ${scope.slug})`,
        );
        staticFilters.push(sql`(${sql.join(scopeClauses, sql` OR `)})`);
      }

      const runMatch = async (ftsQuery: string): Promise<readonly DocumentSnippet[]> => {
        const filters = [sql`document_index MATCH ${ftsQuery}`, ...staticFilters];
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
      };

      // Strict-AND first (precise). If it finds nothing and the query has
      // more than one token, widen to OR so a single non-matching token can
      // no longer suppress otherwise-relevant documents.
      const strict = await runMatch(toMatchQuery(tokens, " "));
      if (strict.length > 0 || tokens.length === 1) return strict;
      return runMatch(toMatchQuery(tokens, " OR "));
    },
  };
}

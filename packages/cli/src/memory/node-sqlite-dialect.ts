/**
 * Kysely dialect backed by Node's built-in `node:sqlite` (`DatabaseSync`).
 *
 * Council uses this instead of `@libsql/client` so the CLI runs on every
 * platform Node supports — including Windows on ARM64, for which the native
 * `libsql` addon ships no prebuilt binary at any version (the optional
 * `@libsql/win32-arm64-msvc` package does not exist). `node:sqlite` is bundled
 * with Node (available unflagged from Node 24+), so it is dependency-free and
 * platform-independent. See DECISIONS.md ADR superseding ADR-005.
 *
 * Kysely's own `SqliteAdapter`, `SqliteIntrospector` and `SqliteQueryCompiler`
 * are reused verbatim — only the Driver and Connection are custom, because
 * `node:sqlite`'s `StatementSync` API differs from better-sqlite3:
 *   - bound parameters are passed as spread arguments, not a single array;
 *   - there is no `stmt.reader` flag, so we derive read-vs-write from
 *     `stmt.columns().length` (0 for INSERT/UPDATE/DELETE/DDL/BEGIN,
 *     > 0 for SELECT, `INSERT … RETURNING`, and row-returning PRAGMAs).
 *
 * The Driver takes a single `DatabaseSync` instance (mirroring
 * `LibsqlDialect({ client })`) so callers can share one handle between Kysely
 * and any raw statements they run directly (e.g. the migration runner).
 */
import { type DatabaseSync, type StatementSync } from "node:sqlite";

import {
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

/** Values `node:sqlite` accepts as bound parameters. */
type SqliteBindValue = null | number | bigint | string | Uint8Array;

export interface NodeSqliteDialectConfig {
  /** An open `node:sqlite` database handle. */
  readonly database: DatabaseSync;
}

/**
 * Kysely {@link Dialect} that executes queries against a `node:sqlite`
 * `DatabaseSync` handle.
 */
export class NodeSqliteDialect implements Dialect {
  readonly #config: NodeSqliteDialectConfig;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#config.database);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/**
 * Driver that wraps a single shared {@link DatabaseSync}. `node:sqlite` is a
 * single synchronous connection, so a mutex serializes Kysely's connection
 * acquisition exactly like the built-in SQLite driver does.
 */
export class NodeSqliteDriver implements Driver {
  readonly #database: DatabaseSync;
  readonly #mutex = new ConnectionMutex();
  #connection: NodeSqliteConnection | undefined;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async init(): Promise<void> {
    this.#connection = new NodeSqliteConnection(this.#database);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.lock();
    if (this.#connection === undefined) {
      this.#connection = new NodeSqliteConnection(this.#database);
    }
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#database.close();
  }
}

/**
 * A single `node:sqlite` connection. Exported so tests can observe the exact
 * compiled SQL by spying on {@link NodeSqliteConnection.executeQuery}.
 */
export class NodeSqliteConnection implements DatabaseConnection {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const statement = this.#database.prepare(sql);
    const params = parameters as readonly SqliteBindValue[];

    if (isReaderStatement(statement)) {
      return Promise.resolve({ rows: statement.all(...params) as R[] });
    }

    const { changes, lastInsertRowid } = statement.run(...params);
    return Promise.resolve({
      numAffectedRows: toBigInt(changes),
      insertId: toBigInt(lastInsertRowid),
      rows: [],
    });
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
  ): AsyncIterableIterator<QueryResult<R>> {
    const { sql, parameters, query } = compiledQuery;
    if (!SelectQueryNode.is(query)) {
      throw new Error("node:sqlite driver only supports streaming select queries");
    }

    const statement = this.#database.prepare(sql);
    for (const row of statement.iterate(...(parameters as readonly SqliteBindValue[]))) {
      yield { rows: [row as R] };
    }
  }
}

/**
 * Whether a prepared statement returns rows. `node:sqlite` has no `reader`
 * flag; a statement that produces result columns is a reader (SELECT,
 * `INSERT … RETURNING`, row-returning PRAGMA), while writers and DDL report
 * zero columns.
 */
function isReaderStatement(statement: StatementSync): boolean {
  try {
    return statement.columns().length > 0;
  } catch {
    return false;
  }
}

function toBigInt(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

/**
 * Serializes access to the single underlying connection, mirroring Kysely's
 * built-in SQLite driver.
 */
class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }

    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}

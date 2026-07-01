import { DatabaseSync } from "node:sqlite";

import { CompiledQuery, type Generated, Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NodeSqliteConnection,
  NodeSqliteDialect,
  NodeSqliteDriver,
} from "../../../src/memory/node-sqlite-dialect.js";

interface WidgetsTable {
  readonly id: Generated<number>;
  readonly name: string;
  readonly qty: number;
}

interface TestSchema {
  readonly widgets: WidgetsTable;
}

function makeDb(raw: DatabaseSync): Kysely<TestSchema> {
  return new Kysely<TestSchema>({
    dialect: new NodeSqliteDialect({ database: raw }),
  });
}

describe("NodeSqliteDialect", () => {
  let raw: DatabaseSync;
  let db: Kysely<TestSchema>;

  beforeEach(() => {
    raw = new DatabaseSync(":memory:");
    raw.exec(
      "CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0)",
    );
    db = makeDb(raw);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("round-trips an insert and select", async () => {
    await db.insertInto("widgets").values({ name: "alpha", qty: 3 }).execute();

    const rows = await db.selectFrom("widgets").selectAll().execute();

    expect(rows).toEqual([{ id: 1, name: "alpha", qty: 3 }]);
  });

  it("binds positional parameters in a WHERE clause", async () => {
    await db
      .insertInto("widgets")
      .values([
        { name: "a", qty: 1 },
        { name: "b", qty: 2 },
      ])
      .execute();

    const row = await db
      .selectFrom("widgets")
      .selectAll()
      .where("name", "=", "b")
      .executeTakeFirst();

    expect(row).toMatchObject({ name: "b", qty: 2 });
  });

  it("returns rows for INSERT ... RETURNING", async () => {
    const returned = await db
      .insertInto("widgets")
      .values({ name: "ret", qty: 9 })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(returned).toMatchObject({ name: "ret", qty: 9 });
    expect(returned.id).toBeGreaterThan(0);
  });

  it("reports insertId and affected-row counts for writes", async () => {
    const inserted = await db
      .insertInto("widgets")
      .values({ name: "x", qty: 0 })
      .executeTakeFirstOrThrow();
    expect(inserted.insertId).toBe(1n);

    const updated = await db
      .updateTable("widgets")
      .set({ qty: 5 })
      .where("name", "=", "x")
      .executeTakeFirstOrThrow();
    expect(updated.numUpdatedRows).toBe(1n);
  });

  it("supports FTS5 virtual tables and MATCH queries", async () => {
    raw.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
    raw.exec("INSERT INTO docs(body) VALUES ('the quick brown fox')");

    const hit = await sql<{
      body: string;
    }>`SELECT body FROM docs WHERE docs MATCH ${"quick"}`.execute(db);
    expect(hit.rows).toEqual([{ body: "the quick brown fox" }]);

    const miss = await sql<{
      body: string;
    }>`SELECT body FROM docs WHERE docs MATCH ${"zebra"}`.execute(db);
    expect(miss.rows).toEqual([]);
  });

  it("commits successful transactions and rolls back failed ones", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("widgets").values({ name: "committed", qty: 1 }).execute();
    });

    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .insertInto("widgets")
          .values({ name: "rolled-back", qty: 1 })
          .execute();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const names = (await db.selectFrom("widgets").select("name").execute()).map(
      (r) => r.name,
    );
    expect(names).toContain("committed");
    expect(names).not.toContain("rolled-back");
  });

  it("routes every compiled query through NodeSqliteConnection.executeQuery", async () => {
    const spy = vi.spyOn(NodeSqliteConnection.prototype, "executeQuery");
    try {
      await db.insertInto("widgets").values({ name: "spied", qty: 1 }).execute();

      const statements = spy.mock.calls.map(
        (call) => (call[0] as { readonly sql: string }).sql,
      );
      expect(statements.some((s) => /insert into "widgets"/i.test(s))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects rather than throwing synchronously when a query fails to prepare", async () => {
    const conn = new NodeSqliteConnection(raw);

    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = conn.executeQuery(CompiledQuery.raw("this is not valid sql"));
    }).not.toThrow();

    await expect(promise).rejects.toThrow();
  });

  describe("streamQuery (#1259)", () => {
    it("streams SELECT rows in insertion order, one row per yielded chunk", async () => {
      await db
        .insertInto("widgets")
        .values([
          { name: "alpha", qty: 1 },
          { name: "beta", qty: 2 },
          { name: "gamma", qty: 3 },
        ])
        .execute();

      const conn = new NodeSqliteConnection(raw);
      const compiled = db.selectFrom("widgets").selectAll().orderBy("id").compile();

      const chunks: unknown[] = [];
      for await (const result of conn.streamQuery(compiled)) {
        chunks.push(result.rows);
      }

      expect(chunks).toEqual([
        [{ id: 1, name: "alpha", qty: 1 }],
        [{ id: 2, name: "beta", qty: 2 }],
        [{ id: 3, name: "gamma", qty: 3 }],
      ]);
    });

    it("binds positional parameters when streaming a filtered SELECT", async () => {
      await db
        .insertInto("widgets")
        .values([
          { name: "alpha", qty: 1 },
          { name: "beta", qty: 2 },
          { name: "gamma", qty: 3 },
        ])
        .execute();

      const conn = new NodeSqliteConnection(raw);
      const compiled = db
        .selectFrom("widgets")
        .selectAll()
        .where("qty", ">", 1)
        .orderBy("id")
        .compile();

      const rows: unknown[] = [];
      for await (const result of conn.streamQuery(compiled)) {
        rows.push(...result.rows);
      }

      expect(rows).toEqual([
        { id: 2, name: "beta", qty: 2 },
        { id: 3, name: "gamma", qty: 3 },
      ]);
    });

    it("rejects with a specific error rather than executing a non-select query", async () => {
      const conn = new NodeSqliteConnection(raw);
      const compiled = db.insertInto("widgets").values({ name: "nope", qty: 1 }).compile();

      const iterator = conn.streamQuery(compiled);

      await expect(iterator.next()).rejects.toThrow(
        "node:sqlite driver only supports streaming select queries",
      );

      // The guard must fire before any statement is prepared/executed.
      const rows = await db.selectFrom("widgets").selectAll().execute();
      expect(rows).toEqual([]);
    });
  });

  it("serializes overlapping connection acquisitions through the mutex", async () => {
    const driver = new NodeSqliteDriver(raw);
    await driver.init();

    const first = await driver.acquireConnection();

    let secondAcquired = false;
    const secondPending = driver.acquireConnection().then((conn) => {
      secondAcquired = true;
      return conn;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    await driver.releaseConnection(first);
    const second = await secondPending;

    expect(secondAcquired).toBe(true);
    expect(second).toBe(first);
    await driver.releaseConnection(second);
  });

  it("closes the underlying database when the driver is destroyed", async () => {
    const ownRaw = new DatabaseSync(":memory:");
    const driver = new NodeSqliteDriver(ownRaw);
    await driver.init();

    await driver.destroy();

    expect(() => ownRaw.prepare("SELECT 1")).toThrow();
  });
});

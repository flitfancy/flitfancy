import { DatabaseSync } from "node:sqlite";

// D1 API adapter that executes actual SQLite SQL. Each batch is one transaction,
// including rollback on failure; no query-pattern mocks are used for concurrency guards.
export class SqliteD1 {
  constructor(sqlite = new DatabaseSync(":memory:")) {
    this.sqlite = sqlite;
    this.beforeBatch = null;
  }

  prepare(sql) {
    const db = this.sqlite;
    return {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      async run() { return { success: true, meta: db.prepare(sql).run(...this.values) }; },
      async all() { return { success: true, results: db.prepare(sql).all(...this.values) }; },
    };
  }

  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch(statements);
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map(statement => ({
        success: true,
        results: this.sqlite.prepare(statement.sql).all(...statement.values),
      }));
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

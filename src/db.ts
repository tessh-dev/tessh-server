// A small async SQL layer over node:sqlite. The route code is written against this interface:
// `db.prepare(sql).bind(...).first() / .all() / .run()` and `db.batch([...])`, which runs every statement
// in one transaction and rolls all of them back if any fails.
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type Value = string | number | bigint | null | Uint8Array | boolean;

export interface Meta {
  changes: number;
  last_row_id: number;
}

export interface Result<T = Record<string, unknown>> {
  results: T[];
  meta: Meta;
  success: true;
}

function toSQL(v: Value | undefined, i: number): SQLInputValue {
  if (v === undefined) throw new TypeError(`Bind parameter ${i + 1} is undefined`);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export class Statement {
  readonly sql: string;
  readonly params: readonly Value[];
  private readonly db: Database;

  constructor(db: Database, sql: string, params: readonly Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  /** A copy of this statement with these parameters (positional `?` or numbered `?1`). */
  bind(...params: Value[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  /** The first row, or null. */
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.firstSync<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<Result<T>> {
    return this.execSync<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<Result<T>> {
    return this.execSync<T>();
  }

  firstSync<T>(): T | null {
    const row = this.compiled().get(...this.args());
    return (row as T | undefined) ?? null;
  }

  /** Runs the statement. Statements that return rows (SELECT, RETURNING) report them in `results`. */
  execSync<T>(): Result<T> {
    const st = this.compiled();
    if (st.columns().length > 0) {
      const results = st.all(...this.args()) as T[];
      const changes = this.db.changes();
      return { results, meta: { changes, last_row_id: this.db.lastRowId() }, success: true };
    }
    const r = st.run(...this.args());
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, success: true };
  }

  private compiled(): StatementSync {
    return this.db.compile(this.sql);
  }

  private args(): SQLInputValue[] {
    return this.params.map(toSQL);
  }
}

export interface OpenOptions {
  /** Milliseconds to wait for a lock held by another connection. */
  busyTimeoutMs?: number;
}

export class Database {
  readonly sqlite: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private readonly changesStmt: StatementSync;

  constructor(path: string, opts: OpenOptions = {}) {
    this.sqlite = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.sqlite.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
    if (path !== ":memory:") {
      this.sqlite.exec("PRAGMA journal_mode = WAL");
      this.sqlite.exec("PRAGMA synchronous = NORMAL");
    }
    this.changesStmt = this.sqlite.prepare("SELECT changes() AS c, last_insert_rowid() AS r");
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  /** Runs every statement in one transaction. If any statement fails, none of them take effect. */
  async batch<T = Record<string, unknown>>(statements: Statement[]): Promise<Result<T>[]> {
    return this.batchSync<T>(statements);
  }

  batchSync<T>(statements: Statement[]): Result<T>[] {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => s.execSync<T>());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      if (this.sqlite.isTransaction) this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  /** Runs raw SQL (several statements allowed). For migrations and setup only. */
  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  close(): void {
    this.cache.clear();
    if (this.sqlite.isOpen) this.sqlite.close();
  }

  /** @internal */
  compile(sql: string): StatementSync {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.sqlite.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, st);
    }
    return st;
  }

  /** @internal */
  changes(): number {
    return Number((this.changesStmt.get() as { c: number }).c);
  }

  /** @internal */
  lastRowId(): number {
    return Number((this.changesStmt.get() as { r: number }).r);
  }
}

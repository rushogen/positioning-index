/**
 * A D1-compatible shim over node:sqlite.
 *
 * D1 is SQLite, and the subset of its API this project uses is small:
 * prepare().bind().first()/all()/run() plus batch(). Implementing that over
 * node:sqlite lets the integration test exercise the real scheduled handler,
 * the real SQL in src/db.js and the real schema.sql -- rather than a mock that
 * would happily agree with a broken query.
 *
 * Not a general-purpose D1 emulator. It covers exactly what src/db.js calls.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Stmt(this.db, this.sql, params.map(normalise));
  }

  #prepared() {
    return this.db.prepare(this.sql);
  }

  async all() {
    const results = this.#prepared().all(...this.params);
    return { results: results.map(plain), success: true, meta: {} };
  }

  async first(column) {
    const row = this.#prepared().get(...this.params);
    if (row === undefined) return null;
    const obj = plain(row);
    return column ? obj[column] : obj;
  }

  async run() {
    // A statement with RETURNING must be stepped with get(), not run().
    if (/\bRETURNING\b/i.test(this.sql)) {
      this.#prepared().get(...this.params);
      return { success: true, meta: {} };
    }
    const info = this.#prepared().run(...this.params);
    return { success: true, meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
  }
}

/** null-prototype rows from node:sqlite confuse spread and JSON; normalise them. */
function plain(row) {
  return row ? { ...row } : row;
}

/** node:sqlite accepts null, number, bigint, string, Uint8Array. Coerce the rest. */
function normalise(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export class TestD1 {
  constructor({ schemaPath } = {}) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    if (schemaPath) this.db.exec(readFileSync(schemaPath, 'utf8'));
  }

  prepare(sql) {
    return new Stmt(this.db, sql);
  }

  /** D1 batches are atomic; so is this. */
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.db.close();
  }
}

/** Build an in-memory database with the real schema applied. */
export function makeDb() {
  return new TestD1({ schemaPath: new URL('../../schema.sql', import.meta.url) });
}

/**
 * A fetch() stand-in driven by a route table.
 *
 * Routes map a URL to either a string body, or { status, body, headers }, or a
 * function receiving (url, init). Records every call so tests can assert on
 * request headers and on how many requests were made to a host.
 */
export function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const route = routes[String(url)];
    if (route === undefined) return new Response('not found', { status: 404 });
    const resolved = typeof route === 'function' ? await route(String(url), init) : route;
    if (resolved instanceof Response) return resolved;
    if (typeof resolved === 'string') {
      return new Response(resolved, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(resolved.body ?? '', {
      status: resolved.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(resolved.headers ?? {}) },
    });
  };
  impl.calls = calls;
  impl.callsTo = (host) => calls.filter((c) => new URL(c.url).hostname === host);
  return impl;
}

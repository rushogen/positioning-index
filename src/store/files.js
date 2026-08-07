/**
 * The store: append-only newline-delimited JSON on disk, versioned by git.
 *
 * WHY FILES AND NOT A DATABASE
 * ----------------------------
 * The product of this project is change over time. Git is a diff store. If the
 * data lives in a text format git can diff, then the history of the data is the
 * history of the repository, for free and in public:
 *
 *     git log -p data/companies/linear.ndjson
 *
 * ...is literally a chronological list of every time Linear's positioning moved,
 * with the before and the after side by side, signed and timestamped by a commit
 * nobody can backdate. A SQLite file would give the same information and none of
 * the legibility: an opaque binary blob rewritten wholesale on every write, so
 * every commit is a full-file replacement and `git log -p` says nothing at all.
 * That is why nothing here is ever stored as a binary.
 *
 * THREE FILES, THREE JOBS
 * -----------------------
 *   data/companies/<slug>.ndjson  the series. One line per observation that
 *                                 carried new information. Append-only.
 *   data/events.ndjson            the feed. One line per published change.
 *                                 Append-only.
 *   data/runs.ndjson              the ledger. One line per run, ALWAYS, even
 *                                 when the run found nothing and changed
 *                                 nothing. Append-only.
 *
 * The ledger is the integrity property of the whole system. "We ran and nothing
 * changed" and "we did not run" are the two states a public archive must never
 * confuse, and the only way to tell them apart is to write something down every
 * single time. So a run record is written unconditionally; it is the receipt.
 *
 * WHY OBSERVATIONS ARE DE-DUPLICATED
 * ----------------------------------
 * A company that has not touched its homepage in four months would otherwise
 * contribute 120 byte-identical lines, and `git log -p` on its file would be
 * 120 repetitions with the signal buried in them. So an observation is appended
 * only when it differs from the previous observation of the same page. "We
 * looked and it was the same" is not lost -- it is recorded in the run ledger,
 * which names every target it touched and what happened. The series says what
 * was true; the ledger says when we checked.
 *
 * The comparison deliberately ignores timestamps and includes the derived
 * parser-health state, so an advancing `consecutive_nulls` counter is itself new
 * information and does get appended. That matters: the removal rule in
 * src/diff.js counts consecutive nulls, and a de-duplication that swallowed them
 * would quietly disable it.
 *
 * WHY THERE IS NO SEPARATE STATE FILE
 * -----------------------------------
 * Everything mutable is a fold over the append-only logs:
 *
 *   crawl queue (next_due_at, etag, content_hash, failure counts)
 *       = the last result for each target in data/runs.ndjson
 *   signal state (last known good value, null counters, suspect flags)
 *       = the `state` block of the last line in the company's file
 *
 * There is therefore no file that can disagree with the history, because there
 * is no file besides the history.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** ISO-8601 UTC to the second. Lexicographic order == chronological order. */
export function iso(d = new Date()) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Slug -> file name. Slugs are validated `[a-z0-9-]+` by scripts/check-seed.js. */
function companyFile(root, slug) {
  return join(root, 'companies', `${slug}.ndjson`);
}

async function readLines(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A truncated final line is the only corruption an append-only file can
      // suffer from an interrupted write. Skip it rather than losing the file.
    }
  }
  return out;
}

async function appendLine(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * The fields that decide whether an observation is worth a new line.
 *
 * Everything ending in `_at` is excluded: a value that is still there today is
 * not news just because today has a different date. Everything else -- the
 * values, the extraction method and confidence, the status, the parser-health
 * counters -- is.
 */
export function observationFingerprint(record) {
  const strip = (obj) => {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(strip);
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      if (k.endsWith('_at')) continue;
      out[k] = strip(obj[k]);
    }
    return out;
  };
  return JSON.stringify(strip({
    kind: record.kind,
    status: record.status,
    reason: record.reason,
    doc: record.doc,
    signals: record.signals,
    state: record.state,
  }));
}

/**
 * Rebuild the crawl queue from the run ledger.
 *
 * The last result recorded for a target is that target's current crawl state.
 * Replaying the whole ledger costs one pass over a file that grows by one line
 * per run; at a run a day that is 365 lines a year.
 */
export function queueFromRuns(runs) {
  const queue = new Map();
  for (const run of runs) {
    for (const r of run.results ?? []) {
      const key = `${r.slug}/${r.kind}`;
      const prev = queue.get(key) ?? {};
      queue.set(key, {
        slug: r.slug,
        kind: r.kind,
        last_attempted_at: r.at,
        last_status: r.status,
        last_reason: r.reason ?? null,
        last_ok_at: (r.status === 'ok' || r.status === 'unchanged') ? r.at : (prev.last_ok_at ?? null),
        next_due_at: r.next_due_at ?? null,
        etag: r.etag ?? null,
        last_modified: r.last_modified ?? null,
        content_hash: r.content_hash ?? null,
        consecutive_failures: r.failures ?? 0,
      });
    }
  }
  return queue;
}

export class FileStore {
  /** @param {string} root path to the `data/` directory */
  constructor(root) {
    this.root = root;
    this.runsPath = join(root, 'runs.ndjson');
    this.eventsPath = join(root, 'events.ndjson');
    this._companyCache = new Map();
  }

  async init() {
    await mkdir(join(this.root, 'companies'), { recursive: true });
  }

  // ---------------------------------------------------------------- reading

  async readRuns() {
    return readLines(this.runsPath);
  }

  async readEvents() {
    return readLines(this.eventsPath);
  }

  async readCompany(slug) {
    if (this._companyCache.has(slug)) return this._companyCache.get(slug);
    const rows = await readLines(companyFile(this.root, slug));
    this._companyCache.set(slug, rows);
    return rows;
  }

  /** Every slug that has a series file, sorted. */
  async listSlugs() {
    let names;
    try {
      names = await readdir(join(this.root, 'companies'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names.filter((n) => n.endsWith('.ndjson')).map((n) => n.slice(0, -'.ndjson'.length)).sort();
  }

  /** The most recent observation of one page, or null. */
  async lastObservation(slug, kind) {
    const rows = await this.readCompany(slug);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === kind) return rows[i];
    }
    return null;
  }

  /** The crawl queue, folded from the run ledger. */
  async queue() {
    return queueFromRuns(await this.readRuns());
  }

  /** Every company's series, keyed by slug. */
  async series() {
    const out = new Map();
    for (const slug of await this.listSlugs()) out.set(slug, await this.readCompany(slug));
    return out;
  }

  // ---------------------------------------------------------------- writing

  /**
   * Append an observation unless it repeats the previous one verbatim.
   * @returns {Promise<boolean>} whether a line was written
   */
  async appendObservation(slug, record) {
    const previous = await this.lastObservation(slug, record.kind);
    if (previous && observationFingerprint(previous) === observationFingerprint(record)) {
      return false;
    }
    await appendLine(companyFile(this.root, slug), record);
    this._companyCache.get(slug)?.push(record);
    return true;
  }

  /**
   * Append change events, skipping any (slug, signal, detected_at) triple we
   * already published. Re-running a crawl at the same logical timestamp must be
   * idempotent, exactly as the old UNIQUE constraint made it.
   */
  async appendEvents(events) {
    if (!events.length) return 0;
    const seen = new Set((await this.readEvents()).map((e) => `${e.slug} ${e.signal} ${e.detected_at}`));
    let written = 0;
    for (const e of events) {
      const key = `${e.slug} ${e.signal} ${e.detected_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await appendLine(this.eventsPath, e);
      written++;
    }
    return written;
  }

  /** Always called, exactly once per run. This is the receipt. */
  async appendRun(record) {
    await appendLine(this.runsPath, record);
  }
}

/**
 * robots.txt cache, kept OUT of the repository on purpose.
 *
 * It is third-party content that changes on someone else's schedule, and
 * committing it would fill the history with noise that says nothing about
 * positioning. The consequence is that a fresh CI runner starts cold and fetches
 * robots.txt once per host per run -- which is the politeness budget the crawler
 * documents anyway, so nothing is lost but a little bandwidth.
 */
export function fileRobotsStore(path) {
  let loaded = null;

  const load = async () => {
    if (loaded) return loaded;
    try {
      loaded = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      loaded = {};
    }
    return loaded;
  };

  return {
    async get(host) {
      return (await load())[host] ?? null;
    },
    async put(host, record) {
      const all = await load();
      all[host] = record;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(all, null, 2), 'utf8');
    },
  };
}

/** In-memory robots cache, for dry runs and tests. */
export function memoryRobotsStore(seed = {}) {
  const all = { ...seed };
  return {
    async get(host) { return all[host] ?? null; },
    async put(host, record) { all[host] = record; },
  };
}

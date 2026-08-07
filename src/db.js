/**
 * D1 access layer.
 *
 * Every statement is prepared and bound; there is no string interpolation into
 * SQL anywhere in this file. Reads used by the public API are shaped to hit the
 * indexes declared in schema.sql, because the public fetch handler is the one
 * that genuinely lives under a 10ms CPU ceiling on the free plan.
 *
 * Write budget: a full daily sweep is roughly 120 fetch rows, ~1,300
 * observations, ~120 signal_state upserts and a handful of change events.
 * Comfortably inside D1's 100k rows/day free-tier allowance.
 */

/** ISO-8601 UTC to the second. Matches the format assumed by schema.sql. */
export function iso(d = new Date()) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// companies and targets
// ---------------------------------------------------------------------------

export async function listCompanies(db, { activeOnly = true } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM companies WHERE active = 1 ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM companies ORDER BY name COLLATE NOCASE';
  const { results } = await db.prepare(sql).all();
  return results ?? [];
}

export async function getCompanyBySlug(db, slug) {
  return db.prepare('SELECT * FROM companies WHERE slug = ?').bind(slug).first();
}

/**
 * The scheduler's core query: the single most overdue enabled target.
 *
 * One row per tick is the whole design. It keeps each invocation to one HTTP
 * request and one small parse, and it makes "at most one request per host per
 * tick" true by construction rather than by convention.
 */
export async function claimNextTarget(db, { now = iso() } = {}) {
  return db.prepare(`
    SELECT t.*, c.slug, c.name AS company_name, c.segment
    FROM targets t
    JOIN companies c ON c.id = t.company_id
    WHERE t.enabled = 1 AND c.active = 1 AND t.next_due_at <= ?
    ORDER BY t.next_due_at ASC
    LIMIT 1
  `).bind(now).first();
}

export async function updateTargetAfterFetch(db, target, { status, nextDue, etag, lastModified, contentHash, consecutiveFailures, now = iso() }) {
  const ok = status === 'ok' || status === 'unchanged';
  await db.prepare(`
    UPDATE targets
       SET last_attempted_at = ?, last_status = ?, next_due_at = ?,
           last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END,
           consecutive_failures = ?, etag = ?, last_modified = ?, content_hash = ?
     WHERE id = ?
  `).bind(now, status, nextDue, ok ? 1 : 0, now, consecutiveFailures, etag, lastModified, contentHash, target.id).run();
}

// ---------------------------------------------------------------------------
// robots cache -- the store interface src/crawl/robots.js expects
// ---------------------------------------------------------------------------

export function robotsStore(db) {
  return {
    async get(host) {
      return db.prepare('SELECT * FROM robots_cache WHERE host = ?').bind(host).first();
    },
    async put(host, rec) {
      await db.prepare(`
        INSERT INTO robots_cache (host, body, http_status, fetched_at, expires_at, crawl_delay_s, fetch_error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
          body = excluded.body, http_status = excluded.http_status,
          fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
          crawl_delay_s = excluded.crawl_delay_s, fetch_error = excluded.fetch_error
      `).bind(host, rec.body, rec.http_status, rec.fetched_at, rec.expires_at, rec.crawl_delay_s, rec.fetch_error).run();
    },
  };
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export async function openRun(db, { now = iso() } = {}) {
  const r = await db.prepare('INSERT INTO runs (started_at) VALUES (?) RETURNING id').bind(now).first();
  return r?.id ?? null;
}

export async function currentRunId(db) {
  const r = await db.prepare('SELECT id FROM runs WHERE closed_at IS NULL ORDER BY started_at DESC LIMIT 1').first();
  return r?.id ?? null;
}

export async function closeStaleRuns(db, { now = iso() } = {}) {
  await db.prepare('UPDATE runs SET closed_at = ? WHERE closed_at IS NULL').bind(now).run();
}

export async function bumpRunCounters(db, runId, { status, changes = 0, parserFaults = 0 }) {
  if (!runId) return;
  const col = {
    ok: 'fetch_ok', unchanged: 'fetch_ok', blocked: 'fetch_blocked',
    error: 'fetch_error', 'changed-structure': 'fetch_structure',
  }[status] ?? 'fetch_error';
  await db.prepare(`
    UPDATE runs SET targets_total = targets_total + 1,
                    ${col} = ${col} + 1,
                    changes_found = changes_found + ?,
                    parser_faults = parser_faults + ?
     WHERE id = ?
  `).bind(changes, parserFaults, runId).run();
}

// ---------------------------------------------------------------------------
// fetches, observations, events, state
// ---------------------------------------------------------------------------

export async function recordFetch(db, row) {
  const r = await db.prepare(`
    INSERT INTO fetches (run_id, company_id, target_id, kind, url, fetched_at, http_status,
                         status, reason, content_hash, bytes, duration_ms, signals_found, signals_expected)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    row.run_id ?? null, row.company_id, row.target_id ?? null, row.kind, row.url, row.fetched_at,
    row.http_status ?? null, row.status, row.reason ?? null, row.content_hash ?? null,
    row.bytes ?? 0, row.duration_ms ?? 0, row.signals_found ?? 0, row.signals_expected ?? 0
  ).first();
  return r?.id ?? null;
}

/** signal_state rows for one company, keyed by signal name. */
export async function loadSignalStates(db, companyId, signals) {
  if (!signals.length) return {};
  const placeholders = signals.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT * FROM signal_state WHERE company_id = ? AND signal IN (${placeholders})`
  ).bind(companyId, ...signals).all();
  return Object.fromEntries((results ?? []).map((r) => [r.signal, r]));
}

/**
 * Write one run's worth of rows for a page.
 *
 * D1 batches are atomic, so either the whole page's observations, events and
 * state updates land or none do. A partial write would leave signal_state
 * claiming a baseline that has no observation behind it.
 */
export async function persistPage(db, { companyId, fetchId, runId, now, observations, events, states, extractorVersion }) {
  const stmts = [];

  const obsStmt = db.prepare(`
    INSERT INTO observations (company_id, fetch_id, signal, observed_at, value, value_json, value_hash, method, confidence, extractor_ver)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const o of observations) {
    stmts.push(obsStmt.bind(
      companyId, fetchId, o.signal, now, o.value ?? null,
      o.json ? JSON.stringify(o.json) : null, o.hash ?? null,
      o.method ?? null, o.confidence ?? 1.0, extractorVersion
    ));
  }

  const evStmt = db.prepare(`
    INSERT OR IGNORE INTO change_events
      (company_id, run_id, signal, detected_at, previous_seen_at, before_value, after_value,
       before_json, after_json, change_type, magnitude, oscillating, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const e of events) {
    stmts.push(evStmt.bind(
      companyId, runId, e.signal, now, e.previous_seen_at ?? null,
      e.before_value ?? null, e.after_value ?? null,
      e.before_json ?? null, e.after_json ?? null,
      e.change_type, e.magnitude ?? null, e.oscillating ?? 0, e.summary ?? null
    ));
  }

  const stStmt = db.prepare(`
    INSERT INTO signal_state
      (company_id, signal, last_observed_at, last_good_at, last_good_value, last_good_json,
       last_good_hash, last_good_method, consecutive_nulls, suspect, total_changes, recent_hashes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, signal) DO UPDATE SET
      last_observed_at = excluded.last_observed_at,
      last_good_at = excluded.last_good_at,
      last_good_value = excluded.last_good_value,
      last_good_json = excluded.last_good_json,
      last_good_hash = excluded.last_good_hash,
      last_good_method = excluded.last_good_method,
      consecutive_nulls = excluded.consecutive_nulls,
      suspect = excluded.suspect,
      total_changes = excluded.total_changes,
      recent_hashes = excluded.recent_hashes
  `);
  for (const s of states) {
    stmts.push(stStmt.bind(
      companyId, s.signal, s.last_observed_at, s.last_good_at, s.last_good_value,
      s.last_good_json, s.last_good_hash, s.last_good_method,
      s.consecutive_nulls ?? 0, s.suspect ?? 0, s.total_changes ?? 0, s.recent_hashes ?? null
    ));
  }

  if (stmts.length) await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// public reads
// ---------------------------------------------------------------------------

export async function recentChanges(db, { limit = 60, signal = null, slug = null, before = null } = {}) {
  const where = [];
  const binds = [];
  if (signal) { where.push('e.signal = ?'); binds.push(signal); }
  if (slug) { where.push('c.slug = ?'); binds.push(slug); }
  if (before) { where.push('e.detected_at < ?'); binds.push(before); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { results } = await db.prepare(`
    SELECT e.id, e.detected_at, e.signal, e.change_type, e.before_value, e.after_value,
           e.magnitude, e.oscillating, e.summary, e.previous_seen_at, c.slug, c.name, c.segment
    FROM change_events e
    JOIN companies c ON c.id = e.company_id
    ${clause}
    ORDER BY e.detected_at DESC, e.id DESC
    LIMIT ?
  `).bind(...binds, Math.min(limit, 200)).all();
  return results ?? [];
}

/**
 * Per-company health.
 *
 * A company is only `ok` if we actually reached it recently AND no signal is
 * flagged suspect. Everything else names the specific problem, because "no
 * changes detected" and "we have not successfully read this page in nine days"
 * must never look the same on the public page.
 */
export async function companyHealth(db, { staleAfterHours = 48 } = {}) {
  const { results } = await db.prepare(`
    SELECT
      c.id, c.slug, c.name, c.segment,
      (SELECT MAX(f.fetched_at) FROM fetches f WHERE f.company_id = c.id) AS last_attempt_at,
      (SELECT MAX(f.fetched_at) FROM fetches f WHERE f.company_id = c.id AND f.status IN ('ok','unchanged')) AS last_ok_at,
      (SELECT f.status FROM fetches f WHERE f.company_id = c.id ORDER BY f.fetched_at DESC LIMIT 1) AS last_status,
      (SELECT f.reason FROM fetches f WHERE f.company_id = c.id ORDER BY f.fetched_at DESC LIMIT 1) AS last_reason,
      (SELECT COUNT(*) FROM signal_state s WHERE s.company_id = c.id AND s.suspect = 1) AS suspect_signals,
      (SELECT COUNT(*) FROM signal_state s WHERE s.company_id = c.id AND s.last_good_value IS NOT NULL) AS live_signals,
      (SELECT COUNT(*) FROM change_events e WHERE e.company_id = c.id) AS total_changes,
      (SELECT s.last_good_value FROM signal_state s WHERE s.company_id = c.id AND s.signal = 'category_label') AS category,
      (SELECT s.last_good_value FROM signal_state s WHERE s.company_id = c.id AND s.signal = 'pricing_entry_price') AS entry_price,
      (SELECT s.last_good_value FROM signal_state s WHERE s.company_id = c.id AND s.signal = 'headline') AS headline
    FROM companies c
    WHERE c.active = 1
    ORDER BY c.name COLLATE NOCASE
  `).all();

  const cutoff = Date.now() - staleAfterHours * 3600_000;
  return (results ?? []).map((r) => ({ ...r, health: classifyHealth(r, cutoff) }));
}

export function classifyHealth(row, cutoff) {
  if (!row.last_attempt_at) return 'pending';
  if (row.last_status === 'blocked') return 'blocked';
  if (!row.last_ok_at || Date.parse(row.last_ok_at) < cutoff) return 'stale';
  if (row.last_status === 'changed-structure') return 'structure-changed';
  if (row.last_status === 'error') return 'error';
  if (row.suspect_signals > 0) return 'degraded';
  return 'ok';
}

/** One company's full current state plus its change history. */
export async function companyDetail(db, slug, { historyLimit = 100 } = {}) {
  const company = await getCompanyBySlug(db, slug);
  if (!company) return null;

  const [state, events, fetches] = await Promise.all([
    db.prepare('SELECT * FROM signal_state WHERE company_id = ? ORDER BY signal').bind(company.id).all(),
    db.prepare(`
      SELECT id, detected_at, signal, change_type, before_value, after_value, magnitude, oscillating, summary, previous_seen_at
      FROM change_events WHERE company_id = ? ORDER BY detected_at DESC, id DESC LIMIT ?
    `).bind(company.id, historyLimit).all(),
    db.prepare(`
      SELECT kind, url, fetched_at, http_status, status, reason, bytes, duration_ms, signals_found, signals_expected
      FROM fetches WHERE company_id = ? ORDER BY fetched_at DESC LIMIT 20
    `).bind(company.id).all(),
  ]);

  return {
    company,
    signals: state.results ?? [],
    events: events.results ?? [],
    fetches: fetches.results ?? [],
  };
}

/** The time series for one company+signal. This is the product. */
export async function signalSeries(db, slug, signal, { limit = 365 } = {}) {
  const { results } = await db.prepare(`
    SELECT o.observed_at, o.value, o.method, o.confidence, o.extractor_ver
    FROM observations o
    JOIN companies c ON c.id = o.company_id
    WHERE c.slug = ? AND o.signal = ?
    ORDER BY o.observed_at DESC
    LIMIT ?
  `).bind(slug, signal, Math.min(limit, 1000)).all();
  return results ?? [];
}

/** Index-wide counters for the header of the public page. */
export async function indexStats(db) {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM companies WHERE active = 1) AS companies,
      (SELECT COUNT(*) FROM targets WHERE enabled = 1) AS targets,
      (SELECT COUNT(*) FROM observations) AS observations,
      (SELECT COUNT(*) FROM change_events) AS changes,
      (SELECT COUNT(*) FROM change_events WHERE detected_at >= datetime('now','-7 days')) AS changes_7d,
      (SELECT COUNT(*) FROM change_events WHERE detected_at >= datetime('now','-30 days')) AS changes_30d,
      (SELECT MIN(observed_at) FROM observations) AS first_observation,
      (SELECT MAX(observed_at) FROM observations) AS last_observation,
      (SELECT MAX(fetched_at) FROM fetches WHERE status IN ('ok','unchanged')) AS last_successful_fetch,
      (SELECT COUNT(*) FROM fetches WHERE fetched_at >= datetime('now','-24 hours')) AS fetches_24h,
      (SELECT COUNT(*) FROM fetches WHERE fetched_at >= datetime('now','-24 hours') AND status = 'blocked') AS blocked_24h,
      (SELECT COUNT(*) FROM fetches WHERE fetched_at >= datetime('now','-24 hours') AND status = 'error') AS errors_24h,
      (SELECT COUNT(*) FROM signal_state WHERE suspect = 1) AS suspect_signals
  `).first();
  return row ?? {};
}

/** Which category labels are most common right now. Cheap aggregate for the UI. */
export async function categoryDistribution(db, { limit = 20 } = {}) {
  const { results } = await db.prepare(`
    SELECT s.last_good_value AS label, COUNT(*) AS n
    FROM signal_state s
    JOIN companies c ON c.id = s.company_id AND c.active = 1
    WHERE s.signal = 'category_label' AND s.last_good_value IS NOT NULL
    GROUP BY s.last_good_value
    ORDER BY n DESC, label ASC
    LIMIT ?
  `).bind(limit).all();
  return results ?? [];
}

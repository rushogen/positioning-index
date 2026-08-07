/**
 * Read models.
 *
 * Everything the public site shows is a pure function of the three append-only
 * files, computed here and written out as static JSON by bin/build-site.js.
 * Nothing in this file touches the network, the clock, or the disk, which is
 * what makes the site build deterministic: the same `data/` always produces
 * byte-identical `docs/`.
 *
 * The health model is carried over from the Cloudflare version unchanged,
 * because it encodes the one rule this project cannot bend: a silent failure
 * must never be presented as a quiet week. "ok" requires an actual recent
 * success AND no signal flagged suspect. Every other state names its problem.
 */

const HOUR = 3_600_000;

/**
 * @param {object} row  aggregated per-company crawl facts
 * @param {number} cutoff  epoch ms; a success older than this counts as stale
 */
export function classifyHealth(row, cutoff) {
  if (!row.last_attempt_at) return 'pending';
  if (row.last_status === 'blocked') return 'blocked';
  if (!row.last_ok_at || Date.parse(row.last_ok_at) < cutoff) return 'stale';
  if (row.last_status === 'changed-structure') return 'structure-changed';
  if (row.last_status === 'error') return 'error';
  if (row.suspect_signals > 0) return 'degraded';
  return 'ok';
}

/** The latest observation of each page kind for one company. */
export function latestByKind(records) {
  const out = {};
  for (const r of records) out[r.kind] = r;
  return out;
}

/** Merge the signal state blocks of a company's latest home and pricing lines. */
export function currentSignals(records) {
  const out = {};
  for (const r of records) {
    for (const [signal, state] of Object.entries(r.state ?? {})) out[signal] = state;
  }
  return out;
}

/**
 * Per-company health and headline values.
 *
 * @param {object} args
 * @param {object[]} args.companies   seed entries
 * @param {Map} args.queue            folded crawl queue (src/store/files.js)
 * @param {Map} args.series           slug -> observation records
 * @param {object[]} args.events
 * @param {string} args.asOf          ISO timestamp the report is computed at
 */
export function companyHealth({ companies, queue, series, events, asOf, staleAfterHours = 48 }) {
  const cutoff = Date.parse(asOf) - staleAfterHours * HOUR;
  const changesBySlug = new Map();
  for (const e of events) changesBySlug.set(e.slug, (changesBySlug.get(e.slug) ?? 0) + 1);

  return companies.map((c) => {
    const entries = ['home', 'pricing'].map((k) => queue.get(`${c.slug}/${k}`)).filter(Boolean);
    const newest = entries.slice().sort((a, b) => String(b.last_attempted_at ?? '').localeCompare(String(a.last_attempted_at ?? '')))[0];
    const signals = currentSignals(series.get(c.slug) ?? []);
    const values = Object.values(signals);

    const row = {
      slug: c.slug,
      name: c.name,
      segment: c.segment,
      last_attempt_at: maxOf(entries.map((e) => e.last_attempted_at)),
      last_ok_at: maxOf(entries.map((e) => e.last_ok_at)),
      last_status: newest?.last_status ?? null,
      last_reason: newest?.last_reason ?? null,
      suspect_signals: values.filter((s) => s.suspect).length,
      live_signals: values.filter((s) => s.last_good_value != null).length,
      total_changes: changesBySlug.get(c.slug) ?? 0,
      category: signals.category_label?.last_good_value ?? null,
      entry_price: signals.pricing_entry_price?.last_good_value ?? null,
      headline: signals.headline?.last_good_value ?? null,
    };
    return { ...row, health: classifyHealth(row, cutoff) };
  });
}

/** Index-wide counters for the header of the public page. */
export function indexStats({ companies, queue, series, events, runs, asOf }) {
  const at = Date.parse(asOf);
  const recentRuns = runs.filter((r) => Date.parse(r.finished_at ?? r.started_at) >= at - 24 * HOUR);
  const recentResults = recentRuns.flatMap((r) => r.results ?? []);

  let observations = 0;
  let first = null;
  let last = null;
  let suspect = 0;
  for (const records of series.values()) {
    observations += records.length;
    for (const r of records) {
      if (!first || r.observed_at < first) first = r.observed_at;
      if (!last || r.observed_at > last) last = r.observed_at;
    }
    for (const s of Object.values(currentSignals(records))) if (s.suspect) suspect++;
  }

  const since = (days) => new Date(at - days * 24 * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    companies: companies.length,
    targets: companies.reduce((n, c) => n + (c.pricing_url ? 2 : 1), 0),
    observations,
    changes: events.length,
    changes_7d: events.filter((e) => e.detected_at >= since(7)).length,
    changes_30d: events.filter((e) => e.detected_at >= since(30)).length,
    first_observation: first,
    last_observation: last,
    last_successful_fetch: maxOf([...queue.values()].map((q) => q.last_ok_at)),
    runs: runs.length,
    last_run_at: runs.length ? (runs[runs.length - 1].finished_at ?? runs[runs.length - 1].started_at) : null,
    fetches_24h: recentResults.length,
    blocked_24h: recentResults.filter((r) => r.status === 'blocked').length,
    errors_24h: recentResults.filter((r) => r.status === 'error').length,
    suspect_signals: suspect,
  };
}

/** Which category labels are most common right now. */
export function categoryDistribution({ series, limit = 20 }) {
  const counts = new Map();
  for (const records of series.values()) {
    const label = currentSignals(records).category_label?.last_good_value;
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, n]) => ({ label, n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** The public feed, newest first. */
export function recentChanges(events, { limit = 200 } = {}) {
  return events
    .slice()
    .sort((a, b) => b.detected_at.localeCompare(a.detected_at) || a.slug.localeCompare(b.slug) || a.signal.localeCompare(b.signal))
    .slice(0, limit);
}

/** One company's current state, its change history, and its recent attempts. */
export function companyDetail({ company, queue, records, events, runs, historyLimit = 200, fetchLimit = 20 }) {
  const signals = currentSignals(records);
  const attempts = [];
  for (let i = runs.length - 1; i >= 0 && attempts.length < fetchLimit; i--) {
    for (const r of runs[i].results ?? []) {
      if (r.slug === company.slug) attempts.push(r);
    }
  }

  return {
    company,
    queue: ['home', 'pricing'].map((k) => queue.get(`${company.slug}/${k}`)).filter(Boolean),
    signals: Object.entries(signals)
      .map(([signal, state]) => ({ signal, ...state }))
      .sort((a, b) => a.signal.localeCompare(b.signal)),
    events: recentChanges(events.filter((e) => e.slug === company.slug), { limit: historyLimit }),
    fetches: attempts
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, fetchLimit),
  };
}

function maxOf(values) {
  let best = null;
  for (const v of values) if (v && (!best || v > best)) best = v;
  return best;
}

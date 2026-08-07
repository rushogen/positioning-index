/**
 * The scheduled handler: one page per tick.
 *
 * WHY ONE PAGE
 * ------------
 * Cloudflare's free plan gives a Worker 10ms of CPU per invocation. That number
 * is what shapes this entire file. Parsing a 1.2MB marketing page costs a few
 * milliseconds warm; parsing sixty of them in one invocation costs hundreds and
 * would be killed. So the crawl is not a loop over companies -- it is a queue,
 * and each cron tick claims exactly the single most overdue target, does one
 * HTTP request, one parse, one small batch of writes, and stops.
 *
 * Two crons, out of the five the free plan allows:
 *
 *   *&#47;5 * * * *   tick  -- claim one overdue target and process it
 *   5 0 * * *    daily -- close yesterday's run, open today's
 *
 * 288 ticks a day against ~120 targets means the whole index is swept in about
 * ten hours with room to absorb failures and retries, and every target is
 * visited once per day. It also makes the politeness guarantee structural
 * rather than aspirational: one invocation touches one host, so we physically
 * cannot burst against anyone.
 *
 * FAILING LOUDLY
 * --------------
 * Every outcome is written to `fetches` with a status and a human-readable
 * reason, including the outcomes where nothing happened. A crawler that dies
 * silently at 3am and reports "no changes" is the worst thing a public index
 * can do, so "no changes" and "we could not read the page" are different rows,
 * different statuses, and different colours on the public page.
 */

import { extract, signalsFor, EXTRACTOR_VERSION } from './extract/index.js';
import { diffPage, gatePage } from './diff.js';
import { fetchPage, nextDueAt } from './crawl/fetch.js';
import { fnv1a } from './hash.js';
import { canonical } from './diff.js';
import {
  bumpRunCounters, claimNextTarget, closeStaleRuns, currentRunId, iso, loadSignalStates,
  openRun, persistPage, recordFetch, robotsStore, updateTargetAfterFetch,
} from './db.js';

/**
 * Process exactly one target. Exported so it can be triggered manually from the
 * admin endpoint and driven from tests.
 *
 * @returns {object} a summary of what happened, suitable for logging as JSON
 */
export async function tick(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const nowIso = iso(now);

  const target = await claimNextTarget(db, { now: nowIso });
  if (!target) return { action: 'idle', reason: 'no target is due', at: nowIso };

  const runId = (await currentRunId(db)) ?? (await openRun(db, { now: nowIso }));

  // Move the target's due time forward immediately. If this invocation dies
  // mid-flight, the next tick picks a different target instead of retrying the
  // same one in a hot loop against the same host.
  await db.prepare('UPDATE targets SET next_due_at = ?, last_attempted_at = ? WHERE id = ?')
    .bind(iso(now + 60 * 60_000), nowIso, target.id).run();

  const expected = signalsFor(target.kind);

  const fetched = await fetchPage(target.url, {
    robotsStore: robotsStore(db),
    etag: target.etag,
    lastModified: target.last_modified,
    contentHash: target.content_hash,
    fetchImpl,
    now,
  });

  // ---- Nothing to parse: record the outcome and get out.
  if (fetched.status !== 'ok') {
    const failures = fetched.status === 'unchanged' ? 0 : (target.consecutive_failures ?? 0) + 1;

    await recordFetch(db, {
      run_id: runId, company_id: target.company_id, target_id: target.id,
      kind: target.kind, url: fetched.finalUrl, fetched_at: nowIso,
      http_status: fetched.httpStatus, status: fetched.status, reason: fetched.reason,
      content_hash: fetched.contentHash ?? target.content_hash,
      bytes: fetched.bytes, duration_ms: fetched.durationMs,
      signals_found: 0, signals_expected: expected.length,
    });

    await updateTargetAfterFetch(db, target, {
      status: fetched.status,
      nextDue: iso(nextDueAt({
        status: fetched.status,
        consecutiveFailures: failures,
        crawlDelay: fetched.robots?.crawlDelay ?? null,
        retryAfter: fetched.retryAfter ?? null,
        now,
      })),
      etag: fetched.etag ?? target.etag,
      lastModified: fetched.lastModified ?? target.last_modified,
      contentHash: fetched.contentHash ?? target.content_hash,
      consecutiveFailures: failures,
      now: nowIso,
    });

    await bumpRunCounters(db, runId, { status: fetched.status });

    return {
      action: 'fetched', slug: target.slug, kind: target.kind,
      status: fetched.status, reason: fetched.reason, http: fetched.httpStatus, at: nowIso,
    };
  }

  // ---- Extract.
  const extraction = extract(target.kind, fetched.body, fetched.finalUrl, {
    brand: target.company_name,
    contentType: fetched.contentType,
  });
  const currentYield = Object.values(extraction.signals).filter(Boolean).length;

  // ---- What did we know before?
  const states = await loadSignalStates(db, target.company_id, expected);
  const previousYield = Object.values(states).filter((s) => s.last_good_value != null).length;
  const previous = {
    lang: pickPrev(states, 'lang'),
    variant: pickPrev(states, 'variant'),
    canonical: pickPrev(states, 'canonical'),
    extractorVersion: pickPrev(states, 'extractorVersion'),
  };

  const gate = gatePage({
    fetchOk: true,
    extraction,
    previous,
    currentYield,
    previousYield,
  });

  const { results, events } = diffPage({ extraction, states, gate, now: nowIso });

  // ---- Persist. Observations are written even when the gate is closed: the
  // time series must stay complete, only publication is withheld.
  const fetchId = await recordFetch(db, {
    run_id: runId, company_id: target.company_id, target_id: target.id,
    kind: target.kind, url: fetched.finalUrl, fetched_at: nowIso,
    http_status: fetched.httpStatus, status: gate.status,
    reason: gate.reason ?? (gate.diffable ? null : 'suppressed'),
    content_hash: fetched.contentHash, bytes: fetched.bytes, duration_ms: fetched.durationMs,
    signals_found: currentYield, signals_expected: expected.length,
  });

  const observations = expected.map((signal) => {
    const s = extraction.signals[signal];
    return {
      signal,
      value: s?.value ?? null,
      json: s?.json ?? null,
      hash: s?.value ? fnv1a(canonical(s.value)) : null,
      method: s?.method ?? null,
      confidence: s?.confidence ?? 0,
    };
  });

  // Document facts ride along on the meta signal's state so the next run can
  // detect a locale or variant shift without a second table.
  const statesOut = results.map((r) => {
    const st = { ...r.state };
    st.last_good_json = attachFacts(st, extraction, r.signal, expected[0]);
    return st;
  });

  await persistPage(db, {
    companyId: target.company_id,
    fetchId, runId, now: nowIso,
    observations, events, states: statesOut,
    extractorVersion: EXTRACTOR_VERSION,
  });

  await updateTargetAfterFetch(db, target, {
    status: gate.status,
    nextDue: iso(nextDueAt({
      status: 'ok',
      consecutiveFailures: 0,
      crawlDelay: fetched.robots?.crawlDelay ?? null,
      now,
    })),
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    contentHash: fetched.contentHash,
    consecutiveFailures: 0,
    now: nowIso,
  });

  const parserFaults = results.filter((r) => r.outcome === 'parser-fault').length;
  await bumpRunCounters(db, runId, { status: gate.status, changes: events.length, parserFaults });

  return {
    action: 'processed',
    slug: target.slug,
    kind: target.kind,
    status: gate.status,
    reason: gate.reason,
    yield: `${currentYield}/${expected.length}`,
    events: events.length,
    parserFaults,
    suppressed: results.filter((r) => r.outcome === 'suppressed').length,
    durationMs: fetched.durationMs,
    at: nowIso,
  };
}

/**
 * Document-level facts (lang, canonical, variant, extractor version) are stored
 * on the first signal's state row rather than in their own table. It is one
 * fewer table and one fewer write per page, and these facts are only ever read
 * together with the states they qualify.
 */
function attachFacts(state, extraction, signal, anchorSignal) {
  if (signal !== anchorSignal) return state.last_good_json;
  const facts = {
    lang: extraction.lang,
    canonical: extraction.canonical,
    variant: extraction.variant,
    extractorVersion: extraction.extractorVersion,
  };
  let payload = null;
  try { payload = state.last_good_json ? JSON.parse(state.last_good_json) : null; } catch { payload = null; }
  return JSON.stringify({ ...(payload ?? {}), __doc: facts });
}

function pickPrev(states, key) {
  for (const s of Object.values(states)) {
    if (!s.last_good_json) continue;
    try {
      const parsed = JSON.parse(s.last_good_json);
      if (parsed?.__doc?.[key] != null) return parsed.__doc[key];
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Daily bookkeeping. Closes any run still open and starts a new one, so the
 * public page can say "the sweep that produced these numbers started at X".
 */
export async function daily(env, { now = Date.now() } = {}) {
  const db = env.DB;
  const nowIso = iso(now);
  await closeStaleRuns(db, { now: nowIso });
  const runId = await openRun(db, { now: nowIso });
  return { action: 'daily', runId, at: nowIso };
}

/**
 * Cron entry point. Cloudflare passes the cron expression that fired, which is
 * how one Worker serves both schedules.
 */
export async function scheduled(event, env, ctx) {
  const handler = event.cron === env.DAILY_CRON ? daily : tick;
  const work = handler(env, {}).then(
    (r) => { console.log(JSON.stringify({ level: 'info', cron: event.cron, ...r })); return r; },
    (err) => {
      // Log loudly and rethrow so the failure shows up in Cloudflare's metrics
      // rather than being swallowed into a quiet "no changes" day.
      console.error(JSON.stringify({ level: 'error', cron: event.cron, error: String(err?.stack ?? err) }));
      throw err;
    }
  );
  ctx.waitUntil(work);
  return work;
}

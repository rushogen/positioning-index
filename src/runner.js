/**
 * The crawl runner.
 *
 * One run = one invocation of `npm run crawl`, locally or on a GitHub Actions
 * runner, executing this exact file. There is no second code path: no emulator,
 * no `wrangler dev`, no "production" variant that behaves differently from the
 * thing you tested. If it works on your laptop it works in CI, because it is the
 * same process reading the same files.
 *
 * WHAT A RUN DOES
 * ---------------
 *   1. Build the target list from seed/companies.json.
 *   2. Fold data/runs.ndjson into the crawl queue (see src/store/files.js).
 *   3. Select targets: the most overdue batch, one company, or everything.
 *   4. For each, in order: robots.txt, one conditional GET, extract, gate, diff.
 *   5. Append observations and events for anything that carried information.
 *   6. Append exactly one run record. Always. Even when nothing happened.
 *
 * Step 6 is not bookkeeping, it is the product's integrity guarantee. An archive
 * whose value is "nothing changed last month" is worthless unless it can also
 * prove it looked. A run that finds nothing still writes a receipt, so a gap in
 * data/runs.ndjson means exactly one thing: nobody ran it.
 *
 * POLITENESS
 * ----------
 * Unchanged from the original design and not negotiable:
 *   - robots.txt is consulted first, per RFC 9309, and fails closed
 *   - robots.txt is fetched at most once per host per run
 *   - requests are strictly serial; there is no concurrency anywhere in here
 *   - consecutive requests to the same host are separated by at least
 *     MIN_HOST_INTERVAL_MS, or the host's Crawl-delay if that is longer
 *   - the User-Agent is truthful and carries a working contact URL
 * The target order deliberately interleaves hosts so that the delay above is
 * usually already satisfied by the time we come back round.
 */

import { extract, signalsFor, familiesOf, EXTRACTOR_VERSION } from './extract/index.js';
import { canonical, corroborateAcquisitions, diffPage, gatePage } from './diff.js';
import { fetchPage, nextDueAt } from './crawl/fetch.js';
import { MIN_HOST_INTERVAL_MS } from './crawl/agent.js';
import { UNKNOWN_ORIGIN, describeOrigin, resolveOrigin } from './crawl/origin.js';
import { fnv1a } from './hash.js';
import { applyResult, iso } from './store/files.js';

const realSleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Every crawlable page in the seed, in a stable order. */
export function targetsFromSeed(seed) {
  const out = [];
  for (const c of seed.companies) {
    for (const [kind, url] of [['home', c.homepage_url], ['pricing', c.pricing_url]]) {
      if (!url) continue;
      out.push({
        slug: c.slug,
        name: c.name,
        segment: c.segment,
        kind,
        url,
        host: new URL(url).hostname,
      });
    }
  }
  return out;
}

/**
 * Which targets does this run touch?
 *
 * `batch` (the default) takes only what is actually due, oldest first. A target
 * that was read four hours ago is not read again, whatever the operator types:
 * "one request per page per day" is a promise made to the sites we crawl, not a
 * default we relax when we are impatient.
 */
export function selectTargets(targets, queue, { mode = 'batch', company = null, limit = 12, now = Date.now() } = {}) {
  const due = (t) => queue.get(`${t.slug}/${t.kind}`)?.next_due_at ?? null;
  const byDue = (a, b) => String(due(a) ?? '').localeCompare(String(due(b) ?? ''));

  if (mode === 'company') {
    const picked = targets.filter((t) => t.slug === company);
    if (!picked.length) throw new Error(`no company with slug "${company}" in seed/companies.json`);
    return interleaveHosts(picked.slice().sort(byDue));
  }

  if (mode === 'all') {
    return interleaveHosts(targets.slice().sort(byDue));
  }

  const nowIso = iso(now);
  const overdue = targets
    .filter((t) => { const d = due(t); return d == null || d <= nowIso; })
    .sort(byDue)
    .slice(0, Math.max(0, limit));
  return interleaveHosts(overdue);
}

/**
 * Reorder so that two pages on the same host are never adjacent while any other
 * host is still waiting. Politeness is enforced by a real delay regardless; this
 * just means the delay has usually already elapsed and the run does not spend
 * its life asleep.
 */
export function interleaveHosts(targets) {
  const groups = new Map();
  for (const t of targets) {
    if (!groups.has(t.host)) groups.set(t.host, []);
    groups.get(t.host).push(t);
  }
  const queues = [...groups.values()];
  const out = [];
  let pushed = true;
  while (pushed) {
    pushed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) { out.push(next); pushed = true; }
    }
  }
  return out;
}

/**
 * Crawl one page and work out what, if anything, it means.
 *
 * Returns { result, observation, events } where `result` always exists (it goes
 * into the run ledger no matter what happened) and the other two are null when
 * there was nothing to say.
 */
export async function crawlTarget(target, ctx, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { store, robotsStore } = ctx;
  const origin = ctx.origin ?? UNKNOWN_ORIGIN;
  const nowIso = iso(now);
  const key = `${target.slug}/${target.kind}`;
  const q = ctx.queue.get(key) ?? {};
  const expected = signalsFor(target.kind);

  // A conditional GET asks "have the bytes changed?", and the honest answer is
  // usually no. But when WE have changed -- a new extractor version reads
  // signals the old one did not -- unchanged bytes still need parsing, and a
  // 304 means they never get it.
  //
  // Left alone this is worse than a slow rollout. The pages that would re-parse
  // are exactly the pages that happen to be edited often, so a new signal's
  // coverage would correlate with how frequently a company touches its
  // homepage, and the resulting distribution would look perfectly plausible
  // while describing publication habits rather than the market. Observed on
  // 2026-08-08: the 1.1.0 sweep returned 304 for 189 of 309 targets and
  // computed anatomy for 64 of 186 home pages.
  //
  // So the cache is bypassed for one sweep after a version bump. The politeness
  // cost is one full body per page, once, which is the same cost as the day the
  // page was first crawled.
  //
  // A page with NO recorded version is stale too, and that is not a detail: the
  // first version of this check read `q.extractor_version && ...`, which meant
  // it could never fire, because no ledger entry carried a version until the
  // commit that introduced the check. The sweep after it re-parsed 65 of 309
  // targets and looked like it had worked. Unknown is not "current" here for the
  // same reason an unknown crawl origin is not "no shift": a gap in what we
  // recorded is a reason to look again, never a reason to assume.
  const staleExtractor = q.extractor_version !== EXTRACTOR_VERSION;
  const fetched = await fetchPage(target.url, {
    robotsStore,
    etag: staleExtractor ? null : (q.etag ?? null),
    lastModified: staleExtractor ? null : (q.last_modified ?? null),
    contentHash: staleExtractor ? null : (q.content_hash ?? null),
    fetchImpl,
    now,
  });

  const crawlDelayMs = Math.max(MIN_HOST_INTERVAL_MS, (fetched.robots?.crawlDelay ?? 0) * 1000);

  // ---- Nothing to parse. The ledger still learns what happened and why.
  if (fetched.status !== 'ok') {
    const failures = fetched.status === 'unchanged' ? 0 : (q.consecutive_failures ?? 0) + 1;

    // One exception to "nothing to parse": a body whose hash has not moved is
    // proof that a value we saw last time is still there, and that is what a
    // pending acquisition (S10) is waiting for. Nothing else about the
    // observation changes, so the store appends a line only if a counter
    // actually advanced -- the same rule that lets a moving null counter through.
    let carried = null;
    let carriedAcquisitions = 0;
    if (fetched.status === 'unchanged') {
      const previousRecord = await store.lastObservation(target.slug, target.kind);
      const states = corroborateAcquisitions(previousRecord, nowIso);
      if (states) {
        carried = { ...previousRecord, observed_at: nowIso, state: states };
        carriedAcquisitions = Object.entries(states)
          .filter(([s, v]) => v.acquisition_runs !== previousRecord.state[s]?.acquisition_runs)
          .length;
      }
    }

    const result = {
      slug: target.slug,
      kind: target.kind,
      url: fetched.finalUrl,
      at: nowIso,
      status: fetched.status,
      reason: fetched.reason ?? null,
      origin: origin.id,
      http: fetched.httpStatus ?? null,
      bytes: fetched.bytes ?? 0,
      duration_ms: fetched.durationMs ?? 0,
      yield: null,
      events: 0,
      parser_faults: 0,
      acquisitions: carriedAcquisitions,
      etag: fetched.etag ?? q.etag ?? null,
      last_modified: fetched.lastModified ?? q.last_modified ?? null,
      content_hash: fetched.contentHash ?? q.content_hash ?? null,
      failures,
      next_due_at: iso(nextDueAt({
        status: fetched.status,
        consecutiveFailures: failures,
        crawlDelay: fetched.robots?.crawlDelay ?? null,
        retryAfter: fetched.retryAfter ?? null,
        now,
      })),
    };
    return { result, observation: carried, events: [], crawlDelayMs, acquisitions: carriedAcquisitions };
  }

  // ---- Extract.
  const extraction = extract(target.kind, fetched.body, fetched.finalUrl, {
    brand: target.name,
    contentType: fetched.contentType,
  });
  const currentYield = Object.values(extraction.signals).filter(Boolean).length;

  // ---- What did we believe before? The last line of the company's file.
  const previousRecord = await store.lastObservation(target.slug, target.kind);
  const states = carryState(previousRecord, q.last_ok_at ?? null);
  const previousYield = Object.values(states).filter((s) => s.last_good_value != null).length;

  // Per-family yields, then and now. The page-wide pair above is kept because
  // the ledger reports it and because gatePage falls back to it when a caller
  // cannot supply this; the gate itself prefers these. See src/diff.js P4.
  const familyYields = {};
  for (const [family, names] of familiesOf(target.kind)) {
    familyYields[family] = {
      previous: names.filter((n) => states[n]?.last_good_value != null).length,
      current: names.filter((n) => extraction.signals[n]).length,
    };
  }

  // Where the previous observation of this page was crawled from. Observations
  // written before 2026-08-07 carry no origin at all; that reads as `unknown`,
  // which the origin rule treats as "cannot rule out a shift" rather than as
  // "no shift". See src/crawl/origin.js.
  const previousOrigin = previousRecord?.origin ?? null;

  const gate = gatePage({
    fetchOk: true,
    extraction,
    previous: previousRecord?.doc ?? {},
    currentYield,
    previousYield,
    familyYields,
    origin,
    previousOrigin,
  });

  // The page-level facts of the previous observation. Nothing gates on them; S10
  // uses them to say whether a value that appeared out of nowhere appeared on a
  // page that had just been read badly.
  const { results, events } = diffPage({
    extraction, states, gate, now: nowIso, origin,
    previous: {
      status: previousRecord?.status ?? null,
      yield: previousRecord?.signals_found ?? null,
      extractorVersion: previousRecord?.doc?.extractorVersion ?? null,
    },
  });

  const observation = {
    observed_at: nowIso,
    slug: target.slug,
    kind: target.kind,
    url: fetched.finalUrl,
    status: gate.status,
    reason: gate.reason ?? null,
    http_status: fetched.httpStatus,
    bytes: fetched.bytes,
    signals_found: currentYield,
    signals_expected: expected.length,
    // WHERE we stood when we read this page. Recorded on every observation,
    // because a value that depends on the client's address is not interpretable
    // without it -- and for the first eight months of this index it was not
    // recorded anywhere, which is how two false Notion pricing events reached
    // the public feed. See CORRECTIONS.md.
    origin,
    doc: {
      lang: extraction.lang,
      canonical: extraction.canonical,
      variant: extraction.variant,
      extractorVersion: extraction.extractorVersion,
    },
    signals: Object.fromEntries(expected.map((signal) => {
      const s = extraction.signals[signal];
      return [signal, s ? {
        value: s.value ?? null,
        hash: s.value ? fnv1a(canonical(s.value)) : null,
        method: s.method ?? null,
        confidence: s.confidence ?? 0,
        json: s.json ?? null,
      } : null];
    })),
    // `state.signal` rather than `r.signal`: diffSignal reports the signal name
    // inside the state it returns, and only the suppressed branch of diffPage
    // also carries it on the result.
    state: Object.fromEntries(results.map((r) => [r.state.signal, r.state])),
  };

  const parserFaults = results.filter((r) => r.outcome === 'parser-fault').length;
  const contextFaults = results.filter((r) => r.outcome === 'origin-shift' || r.outcome === 'currency-shift').length;
  // Signals that gained a value where they had none. Counted and reported for
  // the same reason parser faults are: an acquisition publishes nothing, and a
  // suppression nobody can see is indistinguishable from a crawler that found
  // nothing.
  const acquisitions = results.filter((r) => r.outcome === 'acquisition' || r.outcome === 'acquisition-adopted').length;

  const result = {
    slug: target.slug,
    kind: target.kind,
    url: fetched.finalUrl,
    at: nowIso,
    status: gate.status,
    reason: gate.reason ?? null,
    origin: origin.id,
    http: fetched.httpStatus,
    bytes: fetched.bytes,
    duration_ms: fetched.durationMs,
    yield: `${currentYield}/${expected.length}`,
    events: events.length,
    parser_faults: parserFaults,
    context_faults: contextFaults,
    acquisitions,
    etag: fetched.etag ?? null,
    last_modified: fetched.lastModified ?? null,
    content_hash: fetched.contentHash ?? null,
    extractor_version: EXTRACTOR_VERSION,
    failures: 0,
    next_due_at: iso(nextDueAt({
      status: 'ok',
      consecutiveFailures: 0,
      crawlDelay: fetched.robots?.crawlDelay ?? null,
      now,
    })),
  };

  const decorated = events.map((e) => ({
    detected_at: nowIso,
    slug: target.slug,
    name: target.name,
    segment: target.segment,
    kind: target.kind,
    origin: origin.id,
    signal: e.signal,
    change_type: e.change_type,
    before_value: e.before_value ?? null,
    after_value: e.after_value ?? null,
    before_json: e.before_json ?? null,
    after_json: e.after_json ?? null,
    previous_seen_at: e.previous_seen_at ?? null,
    magnitude: e.magnitude ?? null,
    oscillating: e.oscillating ?? 0,
    summary: e.summary ?? null,
  }));

  return {
    result,
    observation,
    events: decorated,
    crawlDelayMs,
    suppressed: results.filter((r) => r.outcome === 'suppressed').length,
    contextFaults,
    acquisitions,
  };
}

/**
 * Carry the previous line's signal state forward.
 *
 * The one adjustment: `last_good_at` is advanced to the last run in which this
 * page was read successfully. Because an unchanged observation is not appended,
 * the stored timestamp says when the value FIRST appeared, and the diff engine
 * uses it to report when the old value was last seen. The run ledger knows the
 * answer, so we use it.
 */
function carryState(record, lastOkAt) {
  if (!record?.state) return {};
  const out = {};
  for (const [signal, state] of Object.entries(record.state)) {
    out[signal] = state.last_good_value != null && lastOkAt && lastOkAt > (state.last_good_at ?? '')
      ? { ...state, last_good_at: lastOkAt }
      : { ...state };
  }
  return out;
}

/**
 * Run a crawl end to end.
 *
 * @param {object} opts
 * @param {import('./store/files.js').FileStore} opts.store
 * @param {object} opts.seed        parsed seed/companies.json
 * @param {object} opts.robotsStore
 * @param {'batch'|'all'|'company'} [opts.mode]
 * @param {string|null} [opts.company]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.dryRun]   fetch and extract, write absolutely nothing
 * @param {string} [opts.trigger]   'local' | 'github-actions' | ...
 * @param {object} [opts.origin]    pre-resolved crawl origin; resolved here when
 *                                  omitted, at most once per run
 * @param {function} [opts.clock]   epoch-ms source; injected so tests can walk days
 * @param {function} [opts.onResult] progress callback, one call per target
 */
export async function runCrawl({
  store,
  seed,
  robotsStore,
  mode = 'batch',
  company = null,
  limit = 12,
  dryRun = false,
  trigger = 'local',
  origin = null,
  clock = () => Date.now(),
  fetchImpl = fetch,
  sleep = realSleep,
  onResult = () => {},
}) {
  const startedAt = iso(clock());
  const targets = targetsFromSeed(seed);
  const queue = await store.queue();
  const selected = selectTargets(targets, queue, { mode, company, limit, now: clock() });

  // Resolved once, before anything is fetched, and never again: every target in
  // a run shares one vantage point, so paying for the lookup per page would buy
  // nothing. A failure here yields an `unknown` origin and the crawl proceeds --
  // not knowing where we stood is a fact worth recording, and it is never a
  // reason to skip a run.
  const runOrigin = origin ?? await resolveOrigin({ fetchImpl });

  const ctx = { store, robotsStore, queue, origin: runOrigin };
  const results = [];
  const allEvents = [];
  let observationsWritten = 0;
  const hostReadyAt = new Map();

  for (const target of selected) {
    // Politeness floor between two requests to the same host, honoured whether
    // or not the run is in a hurry.
    const ready = hostReadyAt.get(target.host);
    if (ready != null) await sleep(ready - clock());

    let outcome;
    try {
      outcome = await crawlTarget(target, ctx, { now: clock(), fetchImpl });
    } catch (err) {
      // A crash while processing one page must not lose the run record for the
      // other fifty-nine, and must not be indistinguishable from silence.
      outcome = {
        result: {
          slug: target.slug, kind: target.kind, url: target.url, at: iso(clock()),
          status: 'error', reason: `runner crashed: ${err?.message ?? err}`,
          http: null, bytes: 0, duration_ms: 0, yield: null, events: 0, parser_faults: 0,
          etag: null, last_modified: null, content_hash: null,
          failures: (queue.get(`${target.slug}/${target.kind}`)?.consecutive_failures ?? 0) + 1,
          next_due_at: iso(nextDueAt({ status: 'error', consecutiveFailures: 1, now: clock() })),
        },
        observation: null, events: [], crawlDelayMs: MIN_HOST_INTERVAL_MS,
      };
    }

    hostReadyAt.set(target.host, clock() + outcome.crawlDelayMs);

    if (!dryRun) {
      if (outcome.observation && await store.appendObservation(target.slug, outcome.observation)) {
        observationsWritten++;
      }
      if (outcome.events.length) await store.appendEvents(outcome.events);
    } else if (outcome.observation) {
      observationsWritten++;
    }

    applyResult(queue, outcome.result);

    results.push(outcome.result);
    allEvents.push(...outcome.events);
    onResult(outcome.result, outcome);
  }

  const count = (...statuses) => results.filter((r) => statuses.includes(r.status)).length;
  const run = {
    run: startedAt,
    trigger,
    // `trigger` says who asked for the run; `origin` says where it physically
    // stood while it read the web. They are not the same question, and only the
    // second one explains why a price came back in euros.
    origin: runOrigin,
    mode: mode === 'company' ? `company:${company}` : mode,
    dry_run: dryRun || undefined,
    started_at: startedAt,
    finished_at: iso(clock()),
    targets: results.length,
    ok: count('ok'),
    unchanged: count('unchanged'),
    blocked: count('blocked'),
    error: count('error'),
    structure: count('changed-structure'),
    origin_shift: count('origin-shift'),
    changes: allEvents.length,
    parser_faults: results.reduce((n, r) => n + (r.parser_faults ?? 0), 0),
    context_faults: results.reduce((n, r) => n + (r.context_faults ?? 0), 0),
    acquisitions: results.reduce((n, r) => n + (r.acquisitions ?? 0), 0),
    observations: observationsWritten,
    results,
  };

  // The receipt. Unconditional: a run that touched nothing still proves it ran.
  if (!dryRun) await store.appendRun(run);

  return { run, events: allEvents };
}

/**
 * The commit subject for a run.
 *
 * `Update data` tells a future reader nothing. The git log is the public record
 * of this index, so the message says what moved and who moved it -- which makes
 * `git log --oneline data/` a readable changelog of the whole market.
 */
export function commitMessage(run) {
  if (run.targets === 0) return 'data: run recorded, no targets were due';

  const movers = [];
  for (const r of run.results) {
    if (r.events > 0 && !movers.includes(r.slug)) movers.push(r.slug);
  }

  const head = run.changes === 0
    ? `data: no changes across ${run.targets} target${run.targets === 1 ? '' : 's'}`
    : `data: ${run.changes} change${run.changes === 1 ? '' : 's'} across ${run.targets} target${run.targets === 1 ? '' : 's'}` +
      ` (${movers.slice(0, 3).join(', ')}${movers.length > 3 ? `, +${movers.length - 3} more` : ''})`;

  const notes = [];
  if (run.blocked) notes.push(`${run.blocked} blocked`);
  if (run.error) notes.push(`${run.error} error${run.error === 1 ? '' : 's'}`);
  if (run.structure) notes.push(`${run.structure} restructured`);
  if (run.origin_shift) notes.push(`${run.origin_shift} origin-shifted`);
  if (run.parser_faults) notes.push(`${run.parser_faults} parser fault${run.parser_faults === 1 ? '' : 's'}`);
  if (run.context_faults) notes.push(`${run.context_faults} context fault${run.context_faults === 1 ? '' : 's'}`);
  if (run.acquisitions) notes.push(`${run.acquisitions} acquisition${run.acquisitions === 1 ? '' : 's'}`);

  return notes.length ? `${head}, ${notes.join(', ')}` : head;
}

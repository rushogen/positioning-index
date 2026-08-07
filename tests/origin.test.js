/**
 * Crawl-origin tests.
 *
 * The central property under test is the sibling of the one in diff.test.js. A
 * value going from something to null is a PARSER fault. A value going from EUR
 * to USD because the request left from a different continent is a CONTEXT fault.
 * Neither may ever become a change event, and neither may ever be silently
 * dropped: both are recorded in full and only the public claim is withheld.
 *
 * The first test in this file replays the actual incident that caused all of
 * this, from the actual lines still in data/companies/notion.ndjson. See
 * CORRECTIONS.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { mockFetch } from './helpers/mock-fetch.js';
import { FileStore, isRetraction, memoryRobotsStore } from '../src/store/files.js';
import { runCrawl } from '../src/runner.js';
import { partitionEvents, recentChanges, companyHealth, indexStats } from '../src/report.js';
import { ACCEPT_LANGUAGE } from '../src/crawl/agent.js';
import {
  CURRENCY_CONFIRMATIONS, currencyShift, diffPage, diffSignal, emptyState, gatePage,
} from '../src/diff.js';
import {
  UNKNOWN_ORIGIN, describeOrigin, environmentOf, originId, originsDiffer, parseTrace, resolveOrigin,
} from '../src/crawl/origin.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-08-08T03:00:00Z';

const LOCAL_DE = { environment: 'local', country: 'DE', region: 'FRA', method: 'cdn-trace', id: 'local:DE' };
const ACTIONS_US = { environment: 'github-actions', country: 'US', region: 'IAD', method: 'cdn-trace', id: 'github-actions:US' };
const ACTIONS_US2 = { ...ACTIONS_US, region: 'DFW' };

// ---------------------------------------------------------------------------
// The incident, replayed from the archive
// ---------------------------------------------------------------------------

/** Rebuild an extractor result from an observation line, so the archive is the fixture. */
function extractionOf(record) {
  return {
    extractorVersion: record.doc.extractorVersion,
    variant: record.doc.variant,
    extractable: true,
    truncated: false,
    lang: record.doc.lang,
    canonical: record.doc.canonical,
    signals: Object.fromEntries(Object.entries(record.signals).map(([name, s]) => [
      name,
      s && s.value != null ? { value: s.value, method: s.method, confidence: s.confidence, json: s.json } : null,
    ])),
  };
}

const yieldOf = (extraction) => Object.values(extraction.signals).filter(Boolean).length;

async function notionPricingPair() {
  const raw = await readFile(join(ROOT, 'data', 'companies', 'notion.ndjson'), 'utf8');
  const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const before = rows.find((r) => r.kind === 'pricing' && r.observed_at === '2026-08-07T11:11:09Z');
  const after = rows.find((r) => r.kind === 'pricing' && r.observed_at === '2026-08-07T11:18:26Z');
  assert.ok(before && after, 'the two observations from the incident must still be in the archive');
  assert.equal(before.signals.pricing_entry_price.value, 'EUR 9.5');
  assert.equal(after.signals.pricing_entry_price.value, 'USD 10');
  return { before, after };
}

test('a currency change across differing origins is an origin shift, not a price change', async () => {
  const { before, after } = await notionPricingPair();
  const extraction = extractionOf(after);

  const gate = gatePage({
    fetchOk: true,
    extraction,
    previous: before.doc,
    currentYield: yieldOf(extraction),
    previousYield: yieldOf(extractionOf(before)),
    // What the run ledger says: 11:11:09Z ran locally, 11:18:26Z ran on Actions.
    previousOrigin: LOCAL_DE,
    origin: ACTIONS_US,
  });

  assert.equal(gate.status, 'origin-shift', 'the run outcome is classified distinctly, like changed-structure');
  assert.equal(gate.originShift, true);
  assert.equal(gate.diffable, true, 'the page was read fine; only its locale-sensitive signals are held back');
  assert.match(gate.reason, /crawl origin local \(DE\/FRA\) -> github-actions \(US\/IAD\)/);

  const { events, results } = diffPage({ extraction, states: before.state, gate, now: NOW, origin: ACTIONS_US });

  assert.equal(events.length, 0, 'Notion did not change its price; we changed continents');
  for (const signal of ['pricing_entry_price', 'pricing_tiers']) {
    const r = results.find((x) => x.state.signal === signal);
    assert.equal(r.outcome, 'origin-shift');
    assert.equal(r.event, null);
  }
});

test('the same case with no origin recorded on either side is still caught, by the currency rule', async () => {
  // Every observation written before 2026-08-07 has no origin field at all, and
  // a failed origin probe produces the same gap. The archive must not depend on
  // a field it did not have when the damage was done.
  const { before, after } = await notionPricingPair();
  const extraction = extractionOf(after);

  const gate = gatePage({
    fetchOk: true,
    extraction,
    previous: before.doc,
    currentYield: yieldOf(extraction),
    previousYield: yieldOf(extractionOf(before)),
    previousOrigin: null,
    origin: null,
  });

  assert.equal(gate.status, 'ok', 'nothing is known about either origin, so nothing is claimed about them');
  assert.equal(gate.originShift, false);

  const { events, results } = diffPage({ extraction, states: before.state, gate, now: NOW });
  assert.equal(events.length, 0, 'EUR 9.5 -> USD 10 with proportionate amounts is locale routing');
  assert.equal(results.find((r) => r.state.signal === 'pricing_entry_price').outcome, 'currency-shift');
  assert.equal(results.find((r) => r.state.signal === 'pricing_tiers').outcome, 'currency-shift');
});

// ---------------------------------------------------------------------------
// The rules, in isolation
// ---------------------------------------------------------------------------

const priceState = (value, json, over = {}) => ({
  ...emptyState('pricing_entry_price'),
  last_observed_at: '2026-08-07T03:00:00Z',
  last_good_at: '2026-08-07T03:00:00Z',
  last_good_value: value,
  last_good_json: JSON.stringify(json),
  last_good_method: 'heuristic:anchor+price:min',
  last_good_confidence: 0.7,
  ...over,
});

const price = (value, json) => ({ value, method: 'heuristic:anchor+price:min', confidence: 0.7, json });

const EUR = { amount: 9.5, currency: 'EUR', period: null, unit: null, tier: 'Plus' };
const USD = { amount: 10, currency: 'USD', period: null, unit: null, tier: 'Plus' };

test('an origin shift suppresses a price signal and leaves the last known-good value alone', () => {
  const r = diffSignal({
    signal: 'pricing_entry_price',
    current: price('USD 10', USD),
    state: priceState('EUR 9.5', EUR),
    pageHealthy: true,
    now: NOW,
    originShift: true,
    originId: ACTIONS_US.id,
  });

  assert.equal(r.outcome, 'origin-shift');
  assert.equal(r.event, null);
  assert.equal(r.state.suspect, 1);
  assert.equal(r.state.last_good_value, 'EUR 9.5', 'the value we saw from somewhere else must not become the baseline');
});

test('an origin shift does not touch a signal the origin cannot decide', () => {
  const r = diffSignal({
    signal: 'headline',
    current: { value: 'The product development system', method: 'h1', confidence: 1 },
    state: { ...emptyState('headline'), last_good_value: 'The issue tracker', last_good_method: 'h1', last_good_confidence: 1, last_good_at: '2026-08-07T03:00:00Z' },
    pageHealthy: true,
    now: NOW,
    originShift: true,
    originId: ACTIONS_US.id,
  });
  assert.equal(r.outcome, 'changed', 'a hero headline read from Virginia is still comparable with one read from Frankfurt');
  assert.ok(r.event);
});

test('a currency change with a disproportionate price move is a real repricing and is published', () => {
  const r = diffSignal({
    signal: 'pricing_entry_price',
    current: price('USD 39', { ...USD, amount: 39 }),
    state: priceState('EUR 9.5', EUR),
    pageHealthy: true,
    now: NOW,
    originId: 'local:DE',
  });
  assert.equal(r.outcome, 'changed');
  assert.ok(r.event, 'x4.1 is nobody\'s exchange rate; that is a repricing that also changed currency');
});

test('a currency shift is only adopted after corroboration from a stable origin, and never published', () => {
  let state = priceState('EUR 9.5', EUR);
  const events = [];
  for (let run = 1; run <= CURRENCY_CONFIRMATIONS; run++) {
    const r = diffSignal({
      signal: 'pricing_entry_price',
      current: price('USD 10', USD),
      state,
      pageHealthy: true,
      now: NOW,
      originId: ACTIONS_US.id,
    });
    if (r.event) events.push(r.event);
    if (run < CURRENCY_CONFIRMATIONS) {
      assert.equal(r.outcome, 'currency-shift');
      assert.equal(r.state.last_good_value, 'EUR 9.5', `run ${run} must not adopt the new currency yet`);
    } else {
      assert.equal(r.outcome, 'currency-rebaselined');
      assert.equal(r.state.last_good_value, 'USD 10', 'after corroboration it becomes the baseline');
    }
    state = r.state;
  }
  assert.equal(events.length, 0, 'a currency-only move is never published, however many times it is confirmed');
});

test('the corroboration counter restarts when the origin moves under it', () => {
  let state = priceState('EUR 9.5', EUR);
  for (const origin of [ACTIONS_US.id, 'local:DE', ACTIONS_US.id, ACTIONS_US.id]) {
    const r = diffSignal({
      signal: 'pricing_entry_price', current: price('USD 10', USD), state, pageHealthy: true, now: NOW, originId: origin,
    });
    state = r.state;
    assert.equal(r.event, null);
  }
  assert.equal(state.last_good_value, 'EUR 9.5', 'four runs, but never three consecutive from one place');
  assert.equal(state.currency_shift_runs, 2);
});

test('currencyShift measures proportionality, not merely difference', () => {
  const tiers = (currency, amounts) => ({
    tiers: [
      { name: 'Free', amount: 0, currency },
      { name: 'Plus', amount: amounts[0], currency },
      { name: 'Business', amount: amounts[1], currency },
    ],
  });

  const routed = currencyShift(
    { value: 'x', json: tiers('EUR', [9.5, 19.5]) },
    { value: 'y', json: tiers('USD', [10, 20]) },
  );
  assert.equal(routed.proportionate, true);
  assert.equal(routed.from, 'EUR');
  assert.equal(routed.to, 'USD');

  const repriced = currencyShift(
    { value: 'x', json: tiers('EUR', [9.5, 19.5]) },
    { value: 'y', json: tiers('USD', [10, 60]) },
  );
  assert.equal(repriced.proportionate, false, 'one tier tripling while another holds is not an exchange rate');

  assert.equal(
    currencyShift({ value: 'USD 10', json: USD }, { value: 'USD 12', json: { ...USD, amount: 12 } }),
    null,
    'same currency: not a currency shift at all',
  );
});

// ---------------------------------------------------------------------------
// Origin resolution
// ---------------------------------------------------------------------------

test('the environment is read exactly, and the country never guessed', async () => {
  assert.equal(environmentOf({ GITHUB_ACTIONS: 'true' }), 'github-actions');
  assert.equal(environmentOf({ RUNNER_OS: 'Linux' }), 'github-actions');
  assert.equal(environmentOf({}), 'local');

  const probed = await resolveOrigin({
    env: {},
    fetchImpl: async () => new Response('fl=15f101\nloc=DE\ncolo=FRA\n', { status: 200 }),
  });
  assert.deepEqual(
    probed,
    { environment: 'local', country: 'DE', region: 'FRA', method: 'cdn-trace', id: 'local:DE' },
  );

  // Every way the lookup can fail lands on `unknown`, and none of them throw.
  for (const fetchImpl of [
    async () => { throw new Error('ENOTFOUND'); },
    async () => new Response('', { status: 503 }),
    async () => new Response('fl=15f101\ncolo=FRA\n', { status: 200 }),
  ]) {
    const o = await resolveOrigin({ env: { GITHUB_ACTIONS: 'true' }, fetchImpl });
    assert.equal(o.country, null);
    assert.equal(o.id, 'github-actions:unknown');
    assert.equal(o.environment, 'github-actions', 'what we DO know is still recorded');
  }
});

test('origin is recorded on every observation, and `unknown` is handled', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch(routes(USD_PAGE));

  const { run } = await runCrawl({
    store, seed: SEED, robotsStore: memoryRobotsStore(), mode: 'all',
    clock: () => T(1), fetchImpl, sleep: async () => {}, origin: ACTIONS_US,
  });

  assert.deepEqual(run.origin, ACTIONS_US, 'the run ledger says where the run stood, not only who asked for it');
  assert.equal(run.results[0].origin, 'github-actions:US', 'and so does every target result');

  const [home, pricing] = await store.readCompany('acme');
  for (const record of [home, pricing].filter(Boolean)) {
    assert.deepEqual(record.origin, ACTIONS_US, 'every observation line carries the origin that produced it');
  }

  // `unknown` is a value, and it is a different value from "the same as before".
  assert.equal(originId({ environment: 'local', country: null }), 'local:unknown');
  assert.equal(describeOrigin(UNKNOWN_ORIGIN), 'unknown (country unknown)');
  assert.deepEqual(parseTrace('warp=off\nloc=US\ncolo=IAD'), { country: 'US', region: 'IAD' });

  assert.equal(originsDiffer(LOCAL_DE, ACTIONS_US), 'different');
  assert.equal(originsDiffer(LOCAL_DE, { ...LOCAL_DE, region: 'MUC' }), 'same', 'the edge PoP is not the origin');
  assert.equal(originsDiffer(ACTIONS_US, ACTIONS_US2), 'same');
  assert.equal(originsDiffer(null, ACTIONS_US), 'indeterminate', 'an observation from before origins existed');
  assert.equal(
    originsDiffer({ environment: 'local', country: null }, { environment: 'local', country: null }),
    'indeterminate',
    'two failed probes are not evidence of standing still',
  );
});

test('the crawler asks for one fixed language on every request, whatever machine it is on', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch(routes(USD_PAGE));
  await runCrawl({
    store, seed: SEED, robotsStore: memoryRobotsStore(), mode: 'all',
    clock: () => T(1), fetchImpl, sleep: async () => {}, origin: ACTIONS_US,
  });

  assert.ok(fetchImpl.calls.length >= 2);
  for (const call of fetchImpl.calls) {
    assert.equal(call.headers['accept-language'], ACCEPT_LANGUAGE);
    assert.equal(call.headers['accept-language'], 'en-US,en;q=0.9');
  }
});

// ---------------------------------------------------------------------------
// End to end, through the real store
// ---------------------------------------------------------------------------

const HOST = 'https://acme.test';
const HOME = `${HOST}/`;
const PRICING = `${HOST}/pricing`;

const SEED = { companies: [{ slug: 'acme', name: 'Acme', segment: 'product-dev', homepage_url: HOME, pricing_url: PRICING }] };

const HOMEPAGE = `<!DOCTYPE html><html lang="en"><head><title>Acme</title>
<meta name="description" content="Plan and build products with your whole team."></head>
<body><h1>The product development system for teams</h1>
<p>Plan and build products with your whole team, in one place.</p></body></html>`;

/** The same three plans, quoted by an origin that decided we are European / American. */
const pricingPage = (free, plus, business) => `<!DOCTYPE html><html lang="en">
<head><title>Acme Pricing</title><link rel="canonical" href="${PRICING}"></head>
<body><h1>Pricing</h1>
<h2>Free plan</h2><p>${free}</p>
<h2>Plus plan</h2><p>${plus} per user</p>
<h2>Business plan</h2><p>${business} per user</p>
</body></html>`;

const EUR_PAGE = pricingPage('0 €', '9,50 €', '19,50 €');
const USD_PAGE = pricingPage('$0', '$10', '$20');
const USD_RAISED = pricingPage('$0', '$15', '$30');

const routes = (pricing) => ({
  [`${HOST}/robots.txt`]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
  [HOME]: HOMEPAGE,
  [PRICING]: () => (typeof pricing === 'function' ? pricing() : pricing),
});

const T = (day) => Date.parse(`2026-08-${String(day).padStart(2, '0')}T03:00:00Z`);

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'positioning-origin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, 'data'));
  await store.init();
  return store;
}

function crawler(store, fetchImpl) {
  return (at, origin) => runCrawl({
    store, seed: SEED, robotsStore: memoryRobotsStore(), mode: 'all',
    clock: () => at, fetchImpl, sleep: async () => {}, origin,
  });
}

test('an origin shift publishes zero change events and preserves last-known-good', async (t) => {
  const store = await scratch(t);
  let pricing = EUR_PAGE;
  const run = crawler(store, mockFetch(routes(() => pricing)));

  await run(T(10), LOCAL_DE);

  const baseline = await store.lastObservation('acme', 'pricing');
  assert.equal(baseline.signals.pricing_entry_price.value, 'EUR 9.5/user');
  assert.deepEqual(baseline.origin, LOCAL_DE);

  // Same page, same plans, same prices. Different continent.
  pricing = USD_PAGE;
  const { run: r } = await run(T(11), ACTIONS_US);

  assert.equal(await store.readEvents().then((e) => e.length), 0, 'zero change events');
  assert.equal(r.changes, 0);
  assert.equal(r.origin_shift, 1);
  assert.ok(r.context_faults >= 2, 'and the run says loudly why it published nothing');

  const shifted = await store.lastObservation('acme', 'pricing');
  assert.equal(shifted.status, 'origin-shift');
  assert.match(shifted.reason, /locale-sensitive signals are not comparable/);
  assert.equal(shifted.signals.pricing_entry_price.value, 'USD 10/user', 'the observation is recorded in full');
  assert.equal(
    shifted.state.pricing_entry_price.last_good_value, 'EUR 9.5/user',
    'the last known-good value survives, so the next European reading diffs against what we believed',
  );

  // The health page says "read successfully but from elsewhere", not "stale".
  const [health] = companyHealth({
    companies: SEED.companies,
    queue: await store.queue(),
    series: await store.series(),
    events: await store.readEvents(),
    asOf: new Date(T(11)).toISOString(),
  });
  assert.equal(health.health, 'origin-shift');
  assert.equal(health.last_ok_at, '2026-08-11T03:00:00Z', 'an origin shift is a successful read, not a failure');
});

test('a genuine price change within a single origin still publishes normally', async (t) => {
  const store = await scratch(t);
  let pricing = USD_PAGE;
  const run = crawler(store, mockFetch(routes(() => pricing)));

  await run(T(10), ACTIONS_US);

  pricing = USD_RAISED;
  const { run: r } = await run(T(11), ACTIONS_US);

  assert.ok(r.changes >= 1, 'same origin, same currency, a real 50% increase: this is news');
  assert.equal(r.origin_shift, 0);

  const events = await store.readEvents();
  const entry = events.find((e) => e.signal === 'pricing_entry_price');
  assert.ok(entry, 'the entry price change must be published');
  assert.equal(entry.before_value, 'USD 10/user');
  assert.equal(entry.after_value, 'USD 15/user');
  assert.match(entry.summary, /Entry price moved from USD 10\/user to USD 15\/user/);
  assert.equal(entry.origin, 'github-actions:US', 'and the claim records where it was observed from');
});

test('a retracted event never appears in the public feed', async (t) => {
  const store = await scratch(t);
  let pricing = USD_PAGE;
  const run = crawler(store, mockFetch(routes(() => pricing)));
  await run(T(10), ACTIONS_US);
  pricing = USD_RAISED;
  await run(T(11), ACTIONS_US);

  const before = await store.readEvents();
  const target = before.find((e) => e.signal === 'pricing_entry_price');
  assert.ok(recentChanges(before).some((e) => e.signal === 'pricing_entry_price'), 'published to begin with');

  await store.appendRetraction({
    retracted_at: '2026-08-12T09:00:00Z',
    slug: target.slug,
    signal: target.signal,
    detected_at: target.detected_at,
    reason: 'published in error during a test of the retraction path',
    correction: 'CORRECTIONS.md',
  });

  const rows = await store.readEvents();
  assert.equal(rows.length, before.length + 1, 'a retraction is an append; nothing was deleted');
  assert.ok(rows.some((r) => isRetraction(r)));
  assert.ok(
    rows.some((r) => !isRetraction(r) && r.signal === 'pricing_entry_price'),
    'the wrong claim stays in the file exactly as it was published',
  );

  const feed = recentChanges(rows);
  assert.equal(feed.filter((e) => e.signal === 'pricing_entry_price').length, 0, 'but it is gone from the feed');
  assert.equal(feed.filter((e) => isRetraction(e)).length, 0, 'and the retraction line is not a feed item either');

  const { published, retracted } = partitionEvents(rows);
  assert.equal(retracted.length, 1);
  assert.equal(retracted[0].retracted, true);
  assert.match(retracted[0].retraction_reason, /published in error/);
  assert.ok(!published.some((e) => e.signal === 'pricing_entry_price'));

  const stats = indexStats({
    companies: SEED.companies,
    queue: await store.queue(),
    series: await store.series(),
    events: rows,
    runs: await store.readRuns(),
    asOf: '2026-08-12T09:00:00Z',
  });
  assert.equal(stats.retracted_changes, 1, 'the withdrawal is counted in public, not hidden');
  assert.equal(stats.changes, published.length);

  const [health] = companyHealth({
    companies: SEED.companies,
    queue: await store.queue(),
    series: await store.series(),
    events: rows,
    asOf: '2026-08-12T09:00:00Z',
  });
  assert.equal(health.total_changes, published.length, 'a retracted claim does not count as a change');
});

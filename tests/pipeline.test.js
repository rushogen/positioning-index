/**
 * End-to-end pipeline tests.
 *
 * These run the actual runner against the actual file store in a real temporary
 * directory, with only the network mocked. The NDJSON that lands on disk is the
 * NDJSON a real crawl would commit, so the storage format, the crawl
 * classification, the page gates, the diff engine and the health model are all
 * exercised together. A mock store would happily agree with a broken writer.
 *
 * The story the tests tell, in order:
 *   day 1  first sweep establishes a baseline and publishes nothing
 *   day 2  an unchanged page costs nothing and produces nothing
 *   day 3  a real rewrite produces exactly one change event
 *   day 4  a redesign that breaks our selectors produces ZERO change events
 *   day 5  the page comes back and the index recovers
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockFetch } from './helpers/mock-fetch.js';
import { FileStore, memoryRobotsStore } from '../src/store/files.js';
import { runCrawl, commitMessage, interleaveHosts, selectTargets, targetsFromSeed } from '../src/runner.js';
import { companyHealth, indexStats, recentChanges, companyDetail, withConfirmation } from '../src/report.js';
import { MIN_HOST_INTERVAL_MS } from '../src/crawl/agent.js';

const HOST = 'https://acme.test';
const ROBOTS = `${HOST}/robots.txt`;
const HOME = `${HOST}/`;
const PRICING = `${HOST}/pricing`;

const homepage = ({ headline, subhead, logos = ['Figma', 'Stripe', 'Linear', 'Vercel'] }) => `<!DOCTYPE html>
<html lang="en"><head>
  <title>${headline} | Acme</title>
  <meta name="description" content="${subhead}">
</head><body>
  <h1>${headline}</h1>
  <p>${subhead}</p>
  <section><h2>Trusted by fast-growing teams</h2>
    ${logos.map((l) => `<img src="/logos/${l.toLowerCase()}.svg" alt="${l}">`).join('\n    ')}
  </section>
  <p>Join 12,000 teams shipping 10x faster.</p>
</body></html>`;

const DAY1 = homepage({ headline: 'The issue tracker teams actually enjoy', subhead: 'Track bugs, plan sprints, ship software on time.' });
const DAY3 = homepage({ headline: 'The product development system for teams and agents', subhead: 'Purpose-built for planning and building products in the AI era.' });

/** A redesign we cannot read: valid HTML, no headings, no logo wall. */
const REDESIGNED = `<!DOCTYPE html><html lang="en"><head><title>Acme</title></head>
<body><div id="app"></div><noscript>Enable JavaScript.</noscript></body></html>`;

const SEED = { companies: [{ slug: 'acme', name: 'Acme', segment: 'product-dev', homepage_url: HOME }] };

const T = (day) => Date.parse(`2026-08-0${day}T03:00:00Z`);

/** A store in a throwaway directory, cleaned up when the test ends. */
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'positioning-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, 'data'));
  await store.init();
  return store;
}

/** One run, with time and the network under the test's control. */
function runner(store, fetchImpl, { seed = SEED, robots = memoryRobotsStore(), sleeps = [] } = {}) {
  return (at, opts = {}) => runCrawl({
    store,
    seed,
    robotsStore: robots,
    mode: 'all',
    clock: () => at,
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    ...opts,
  });
}

const seriesOf = async (store, slug) => store.readCompany(slug);

async function report(store, seed = SEED, asOf = new Date().toISOString()) {
  const [queue, series, events, runs] = await Promise.all([
    store.queue(), store.series(), store.readEvents(), store.readRuns(),
  ]);
  return { companies: seed.companies, queue, series, events, runs, asOf };
}

// ---------------------------------------------------------------------------

test('a full five-day life cycle', async (t) => {
  const store = await scratch(t);
  let homeBody = DAY1;
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => homeBody,
  });
  const run = runner(store, fetchImpl);

  // --- day 1: baseline ------------------------------------------------------
  const r1 = await run(T(1));
  assert.equal(r1.run.results[0].status, 'ok');
  assert.equal(r1.run.changes, 0, 'the first sighting of a company must not spam the feed');
  assert.equal(r1.run.observations, 1);

  const obs1 = (await seriesOf(store, 'acme'))[0];
  assert.equal(Object.keys(obs1.signals).length, 7, 'every declared home signal is stored, including the null ones');
  assert.equal(obs1.signals.headline.value, 'The issue tracker teams actually enjoy');
  assert.equal(obs1.doc.extractorVersion, '1.0.0', 'the line records which extractor produced it');

  // robots.txt cost exactly one request.
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 1);

  // --- day 2: nothing changed ----------------------------------------------
  const r2 = await run(T(2));
  assert.equal(r2.run.results[0].status, 'unchanged', 'an identical body short-circuits before extraction');
  assert.equal(r2.run.changes, 0);
  assert.equal(r2.run.observations, 0, 'an unchanged page adds no line to the series');
  // Exactly one robots.txt request per host per day: the cache TTL is 24h and
  // day 2 is 24h later, so this is the second and only the second.
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 2);

  // Within the same day it is not refetched at all.
  await run(T(2) + 3600_000);
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 2);

  // ...but the run ledger still gained a line for every one of those runs, so
  // "we looked and it was the same" is on the record.
  assert.equal((await store.readRuns()).length, 3);

  // --- day 3: a real repositioning ------------------------------------------
  homeBody = DAY3;
  const r3 = await run(T(3));
  assert.equal(r3.run.results[0].status, 'ok');
  assert.ok(r3.run.changes >= 1, 'a rewritten hero must be detected');

  const changes = recentChanges(await store.readEvents());
  const headlineChange = changes.find((c) => c.signal === 'headline');
  assert.ok(headlineChange, 'headline change missing');
  assert.equal(headlineChange.change_type, 'modified');
  assert.equal(headlineChange.before_value, 'The issue tracker teams actually enjoy');
  assert.equal(headlineChange.after_value, 'The product development system for teams and agents');
  assert.match(headlineChange.summary, /Hero headline changed from/);
  assert.ok(headlineChange.magnitude > 0.3);
  assert.equal(headlineChange.previous_seen_at, '2026-08-02T04:00:00Z',
    'the old value was last confirmed on the most recent successful read, not when it first appeared');

  const categoryChange = changes.find((c) => c.signal === 'category_label');
  assert.ok(categoryChange, 'the category noun moved from "tracker" to "system", which is the headline finding');
  assert.match(categoryChange.summary, /Now calls itself/);

  // --- day 4: THE case. A redesign breaks every selector. -------------------
  homeBody = REDESIGNED;
  const before = (await store.readEvents()).length;
  const r4 = await run(T(4));

  assert.equal(r4.run.results[0].status, 'changed-structure', 'the collapse is recorded as a structure change, loudly');
  assert.equal((await store.readEvents()).length, before, 'a redesign that breaks our parser must produce ZERO change events');
  assert.match(r4.run.results[0].reason, /signal yield fell/);

  // The observation is still written -- the series stays complete, only
  // publication is withheld.
  const day4 = (await seriesOf(store, 'acme')).at(-1);
  assert.equal(day4.observed_at, '2026-08-04T03:00:00Z');
  assert.ok(Object.values(day4.signals).filter((s) => s === null || s.value === null).length >= 4);

  // And the last known-good values survive.
  assert.equal(day4.state.headline.last_good_value, 'The product development system for teams and agents');

  // --- day 5: recovery ------------------------------------------------------
  homeBody = DAY3;
  const r5 = await run(T(5));
  assert.equal(r5.run.results[0].status, 'ok');
  assert.equal((await store.readEvents()).length, before, 'recovering to the previously known value is not a change');
});

// ---------------------------------------------------------------------------

test('a logo wall appearing on a live page publishes nothing until it is corroborated', async (t) => {
  const store = await scratch(t);
  // Same page throughout except for the wall: fewer than three readable names
  // is not a wall, so day 1 extracts null exactly as a broken selector would.
  const WITHOUT = homepage({ headline: 'The issue tracker teams actually enjoy', subhead: 'Track bugs, plan sprints, ship software on time.', logos: ['Figma'] });
  const WITH = homepage({ headline: 'The issue tracker teams actually enjoy', subhead: 'Track bugs, plan sprints, ship software on time.', logos: ['Figma', 'Stripe', 'Linear', 'Vercel'] });

  let homeBody = WITHOUT;
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => homeBody,
  });
  const run = runner(store, fetchImpl);

  await run(T(1));
  const day1 = (await seriesOf(store, 'acme')).at(-1);
  assert.equal(day1.signals.customer_logos, null, 'the fixture must actually start with no readable wall');

  homeBody = WITH;
  for (const day of [2, 3]) {
    const r = await run(T(day));
    assert.equal(r.run.changes, 0, `day ${day}: a wall we could not read before is not a wall they just built`);
    assert.equal(r.run.results[0].acquisitions, 1, 'and the run ledger says an acquisition is being withheld');
    assert.equal((await seriesOf(store, 'acme')).at(-1).state.customer_logos.last_good_value, null);
  }

  // Third consecutive reading of the same value: adopted, still silently.
  const r4 = await run(T(4));
  assert.equal(r4.run.changes, 0, 'adoption is not a change event either');
  assert.equal(r4.run.results[0].acquisitions, 1);

  const adopted = (await seriesOf(store, 'acme')).at(-1).state.customer_logos;
  assert.equal(adopted.last_good_value, 'Figma, Linear, Stripe, Vercel');
  assert.equal(adopted.total_changes, 0);
  assert.equal((await store.readEvents()).length, 0, 'nothing reached the feed at any point');

  // From here it is a normal signal: a swap against the adopted baseline is a
  // real value -> value change and publishes.
  homeBody = homepage({ headline: 'The issue tracker teams actually enjoy', subhead: 'Track bugs, plan sprints, ship software on time.', logos: ['Figma', 'Stripe', 'Linear', 'Ramp'] });
  const r5 = await run(T(5));
  assert.equal(r5.run.changes, 1);
  assert.match((await store.readEvents())[0].summary, /added Ramp; removed Vercel/);
});

test('a change nobody has looked at twice is marked as seen once', async (t) => {
  const store = await scratch(t);
  let homeBody = DAY1;
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => homeBody,
  });
  const run = runner(store, fetchImpl);

  await run(T(1));
  homeBody = DAY3;
  await run(T(2));

  const queue = await store.queue();
  const events = await store.readEvents();

  const fresh = withConfirmation(recentChanges(events), queue);
  assert.ok(fresh.length >= 1);
  assert.ok(fresh.every((e) => e.confirmed === 0), 'the page has not been read since the change was detected');

  // Read it again. The value held, and the site stops hedging.
  await run(T(3));
  const later = withConfirmation(recentChanges(events), await store.queue());
  assert.ok(later.every((e) => e.confirmed === 1));
});

// ---------------------------------------------------------------------------

test('a robots.txt disallow stops the fetch entirely and is recorded as blocked', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nDisallow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
  });

  const { run } = await runner(store, fetchImpl)(T(1));
  assert.equal(run.results[0].status, 'blocked');
  assert.match(run.results[0].reason, /robots\.txt/);

  // The page itself was never requested.
  assert.equal(fetchImpl.calls.filter((c) => c.url === HOME).length, 0);

  const [health] = companyHealth(await report(store));
  assert.equal(health.health, 'blocked');
});

test('a 403 is blocked, not an error, and backs off hard', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: { status: 403, body: 'forbidden' },
  });

  const { run } = await runner(store, fetchImpl)(T(1));
  assert.equal(run.results[0].status, 'blocked');
  assert.match(run.results[0].reason, /refuses identified automated clients/);

  const queue = await store.queue();
  assert.ok(Date.parse(queue.get('acme/home').next_due_at) - T(1) >= 86_400_000, 'a refusal backs off at least a day');
});

test('an agent-specific markdown variant is blocked, not silently parsed', async (t) => {
  // ramp.com does exactly this: text/markdown to any non-browser client.
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: { body: '# Acme — Machine Version\n\nAcme is a spend platform.', headers: { 'content-type': 'text/markdown' } },
  });

  const { run } = await runner(store, fetchImpl)(T(1));
  assert.equal(run.results[0].status, 'blocked');
  assert.match(run.results[0].reason, /non-HTML variant/);
  assert.equal(run.changes, 0);
});

test('a network failure is recorded as an error and backs off', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => { throw new Error('ECONNRESET'); },
  });

  const { run } = await runner(store, fetchImpl)(T(1));
  assert.equal(run.results[0].status, 'error');
  assert.match(run.results[0].reason, /ECONNRESET/);

  const ledger = (await store.readRuns())[0];
  assert.equal(ledger.results[0].status, 'error');
  assert.ok(ledger.results[0].reason, 'the reason is stored, so the health page can say what went wrong');
});

test('a 5xx robots.txt means we never touch the page', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { status: 503, body: '' },
    [HOME]: DAY1,
  });

  const { run } = await runner(store, fetchImpl)(T(1));
  assert.equal(run.results[0].status, 'blocked');
  assert.equal(fetchImpl.calls.filter((c) => c.url === HOME).length, 0, 'fail closed');
});

test('the crawler identifies itself on every request', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
  });
  await runner(store, fetchImpl)(T(1));

  assert.ok(fetchImpl.calls.length >= 2);
  for (const call of fetchImpl.calls) {
    assert.match(call.headers['user-agent'], /^PositioningIndexBot\/1\.0 \(\+https:/);
    assert.ok(call.headers.from, 'a From header carries the contact URL');
  }
});

test('one request per host at a time, paced by the politeness floor', async (t) => {
  const store = await scratch(t);
  const seed = {
    companies: [{ slug: 'acme', name: 'Acme', segment: 'x', homepage_url: HOME, pricing_url: PRICING }],
  };
  const routes = {
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
    [PRICING]: '<!DOCTYPE html><html lang="en"><head><title>Pricing</title></head><body><h1>Pricing</h1></body></html>',
  };
  const fetchImpl = mockFetch(routes);
  const sleeps = [];
  await runner(store, fetchImpl, { seed, sleeps })(1);

  // robots.txt is fetched once for the host and then cached for the whole run.
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 1);
  // The second page on the same host waits out the politeness floor first.
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= MIN_HOST_INTERVAL_MS, `expected a wait of at least ${MIN_HOST_INTERVAL_MS}ms, got ${sleeps[0]}`);
});

test('the target order never puts two pages of one host back to back', () => {
  const seed = {
    companies: [
      { slug: 'a', name: 'A', segment: 'x', homepage_url: 'https://a.test/', pricing_url: 'https://a.test/pricing' },
      { slug: 'b', name: 'B', segment: 'x', homepage_url: 'https://b.test/', pricing_url: 'https://b.test/pricing' },
    ],
  };
  const order = interleaveHosts(targetsFromSeed(seed)).map((t) => t.host);
  assert.deepEqual(order, ['a.test', 'b.test', 'a.test', 'b.test']);
});

test('the queue drains oldest-first and does not re-pick the same target', async (t) => {
  const store = await scratch(t);
  const seed = {
    companies: [
      { slug: 'a', name: 'A', segment: 'x', homepage_url: 'https://a.test/' },
      { slug: 'b', name: 'B', segment: 'x', homepage_url: 'https://b.test/' },
    ],
  };
  const routes = {};
  for (const h of ['a', 'b']) {
    routes[`https://${h}.test/robots.txt`] = { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } };
    routes[`https://${h}.test/`] = DAY1;
  }
  const run = runner(store, mockFetch(routes), { seed });

  const first = await run(T(2), { mode: 'batch', limit: 1 });
  const second = await run(T(2) + 300_000, { mode: 'batch', limit: 1 });
  const third = await run(T(2) + 600_000, { mode: 'batch', limit: 1 });

  assert.equal(first.run.results[0].slug, 'a', 'oldest due first');
  assert.equal(second.run.results[0].slug, 'b');
  assert.equal(third.run.targets, 0, 'nothing left due; the run touches nobody rather than crawling twice in a day');
});

test('a run that touched nothing still leaves a receipt', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
  });
  const run = runner(store, fetchImpl);

  await run(T(1), { mode: 'batch' });
  const idle = await run(T(1) + 60_000, { mode: 'batch' });

  assert.equal(idle.run.targets, 0);
  const runs = await store.readRuns();
  assert.equal(runs.length, 2, 'a run that found nothing due is still written down');
  assert.equal(runs[1].targets, 0);
  assert.ok(runs[1].finished_at, 'the receipt is timestamped');
  assert.match(commitMessage(runs[1]), /no targets were due/);
  // This is the whole point: "ran and found nothing" and "never ran" must not
  // be the same absence of a line.
  assert.notEqual(runs[0].run, runs[1].run);
});

test('a dry run reads the live pipeline and writes absolutely nothing', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
  });

  const { run } = await runner(store, fetchImpl)(T(1), { dryRun: true });
  assert.equal(run.results[0].status, 'ok');
  assert.equal(run.observations, 1, 'it reports what it would have written');
  assert.deepEqual(await store.readRuns(), [], 'no run record');
  assert.deepEqual(await store.readEvents(), [], 'no events');
  assert.deepEqual(await store.listSlugs(), [], 'no series file');
});

test('health never reports a silent failure as "no changes"', async (t) => {
  const store = await scratch(t);
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: { status: 500, body: 'boom' },
  });
  const now = Date.now();
  await runner(store, fetchImpl)(now);

  const model = await report(store, SEED, new Date(now).toISOString());
  const [h] = companyHealth(model);
  assert.notEqual(h.health, 'ok');
  assert.equal(h.health, 'stale', 'never successfully fetched, so it is stale, not healthy');
  assert.ok(h.last_reason, 'the specific reason is available to the public page');

  const stats = indexStats(model);
  assert.equal(stats.changes, 0);
  assert.equal(stats.errors_24h > 0 || stats.blocked_24h > 0, true, 'the failure is visible in the index-wide counters');
  assert.equal(stats.runs, 1, 'and the run itself is counted, so silence is never mistaken for calm');
});

test('companyDetail returns state, events and recent attempts together', async (t) => {
  const store = await scratch(t);
  let body = DAY1;
  const fetchImpl = mockFetch({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => body,
  });
  const run = runner(store, fetchImpl);

  await run(T(1));
  body = DAY3;
  await run(T(3));

  const model = await report(store);
  const detail = companyDetail({
    company: SEED.companies[0],
    queue: model.queue,
    records: model.series.get('acme'),
    events: model.events,
    runs: model.runs,
  });
  assert.equal(detail.company.slug, 'acme');
  assert.ok(detail.signals.length >= 5);
  assert.ok(detail.events.length >= 1);
  assert.equal(detail.fetches.length, 2);
});

test('a company outside the seed list cannot be crawled by name', async (t) => {
  const store = await scratch(t);
  const queue = await store.queue();
  assert.throws(
    () => selectTargets(targetsFromSeed(SEED), queue, { mode: 'company', company: 'nope' }),
    /no company with slug "nope"/
  );
});

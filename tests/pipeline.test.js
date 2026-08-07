/**
 * End-to-end pipeline tests.
 *
 * These run the actual scheduled handler against the actual schema.sql in an
 * in-memory SQLite database, with only the network mocked. That means the SQL
 * in src/db.js, the D1 batch semantics, the crawl classification, the gates and
 * the diff engine are all exercised together -- a mock data layer would happily
 * agree with a broken query.
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

import { makeDb, mockFetch } from '../scripts/lib/sqlite-d1.js';
import { tick, daily } from '../src/scheduled.js';
import { companyHealth, indexStats, recentChanges, companyDetail } from '../src/db.js';

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

function env(routes) {
  const db = makeDb();
  db.exec(`
    INSERT INTO companies (slug, name, homepage_url, pricing_url, segment, added_at, active)
    VALUES ('acme', 'Acme', '${HOME}', '${PRICING}', 'product-dev', '2026-08-01T00:00:00Z', 1);
    INSERT INTO targets (company_id, kind, url, host, next_due_at, enabled)
    VALUES (1, 'home', '${HOME}', 'acme.test', '2026-08-01T00:00:00Z', 1);
  `);
  return { db, fetchImpl: mockFetch(routes) };
}

const T = (day) => Date.parse(`2026-08-0${day}T03:00:00Z`);

// ---------------------------------------------------------------------------

test('a full five-day life cycle', async () => {
  let homeBody = DAY1;
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => homeBody,
  });
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };

  // --- day 1: baseline ------------------------------------------------------
  const r1 = await tick(E, { now: T(1), fetchImpl });
  assert.equal(r1.action, 'processed');
  assert.equal(r1.status, 'ok');
  assert.equal(r1.events, 0, 'the first sighting of a company must not spam the feed');

  const obs1 = (await db.prepare('SELECT * FROM observations').all()).results;
  assert.equal(obs1.length, 7, 'every declared home signal is stored, including the null ones');
  assert.ok(obs1.some((o) => o.signal === 'headline' && o.value === 'The issue tracker teams actually enjoy'));
  assert.ok(obs1.every((o) => o.extractor_ver), 'each observation records which extractor produced it');

  // robots.txt cost exactly one request.
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 1);

  // --- day 2: nothing changed ----------------------------------------------
  await db.prepare("UPDATE targets SET next_due_at = '2026-08-02T00:00:00Z'").run();
  const r2 = await tick(E, { now: T(2), fetchImpl });
  assert.equal(r2.status, 'unchanged', 'an identical body short-circuits before extraction');
  assert.equal(await countEvents(db), 0);
  // Exactly one robots.txt request per host per day: the cache TTL is 24h and
  // day 2 is 24h later, so this is the second and only the second.
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 2);

  // Within the same day it is not refetched at all.
  await db.prepare("UPDATE targets SET next_due_at = '2026-08-02T00:00:00Z'").run();
  await tick(E, { now: T(2) + 3600_000, fetchImpl });
  assert.equal(fetchImpl.callsTo('acme.test').filter((c) => c.url.endsWith('/robots.txt')).length, 2);

  // --- day 3: a real repositioning ------------------------------------------
  homeBody = DAY3;
  await db.prepare("UPDATE targets SET next_due_at = '2026-08-03T00:00:00Z'").run();
  const r3 = await tick(E, { now: T(3), fetchImpl });
  assert.equal(r3.status, 'ok');
  assert.ok(r3.events >= 1, 'a rewritten hero must be detected');

  const changes = await recentChanges(db, {});
  const headlineChange = changes.find((c) => c.signal === 'headline');
  assert.ok(headlineChange, 'headline change missing');
  assert.equal(headlineChange.change_type, 'modified');
  assert.equal(headlineChange.before_value, 'The issue tracker teams actually enjoy');
  assert.equal(headlineChange.after_value, 'The product development system for teams and agents');
  assert.match(headlineChange.summary, /Hero headline changed from/);
  assert.ok(headlineChange.magnitude > 0.3);

  const categoryChange = changes.find((c) => c.signal === 'category_label');
  assert.ok(categoryChange, 'the category noun moved from "tracker" to "system", which is the headline finding');
  assert.match(categoryChange.summary, /Now calls itself/);

  // --- day 4: THE case. A redesign breaks every selector. -------------------
  homeBody = REDESIGNED;
  await db.prepare("UPDATE targets SET next_due_at = '2026-08-04T00:00:00Z'").run();
  const before = await countEvents(db);
  const r4 = await tick(E, { now: T(4), fetchImpl });

  assert.equal(r4.status, 'changed-structure', 'the collapse is recorded as a structure change, loudly');
  assert.equal(await countEvents(db), before, 'a redesign that breaks our parser must produce ZERO change events');
  assert.match(r4.reason, /signal yield fell/);

  // The observations are still written -- the series stays complete, only
  // publication is withheld.
  const obs4 = (await db.prepare("SELECT * FROM observations WHERE observed_at = ?").bind(iso(T(4))).all()).results;
  assert.equal(obs4.length, 7);
  assert.ok(obs4.filter((o) => o.value === null).length >= 4);

  // And the last known-good values survive.
  const state = (await db.prepare("SELECT * FROM signal_state WHERE signal = 'headline'").all()).results[0];
  assert.equal(state.last_good_value, 'The product development system for teams and agents');

  // --- day 5: recovery ------------------------------------------------------
  homeBody = DAY3;
  await db.prepare("UPDATE targets SET next_due_at = '2026-08-05T00:00:00Z'").run();
  const r5 = await tick(E, { now: T(5), fetchImpl });
  assert.equal(r5.status, 'ok');
  assert.equal(await countEvents(db), before, 'recovering to the previously known value is not a change');

  db.close();
});

// ---------------------------------------------------------------------------

test('a robots.txt disallow stops the fetch entirely and is recorded as blocked', async () => {
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nDisallow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
  });
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };

  const r = await tick(E, { now: T(1), fetchImpl });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /robots\.txt/);

  // The page itself was never requested.
  assert.equal(fetchImpl.calls.filter((c) => c.url === HOME).length, 0);

  const [health] = await companyHealth(db);
  assert.equal(health.health, 'blocked');
  db.close();
});

test('a 403 is blocked, not an error, and backs off hard', async () => {
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: { status: 403, body: 'forbidden' },
  });
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };

  const r = await tick(E, { now: T(1), fetchImpl });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /refuses identified automated clients/);

  const target = (await db.prepare('SELECT * FROM targets').all()).results[0];
  assert.ok(Date.parse(target.next_due_at) - T(1) >= 86_400_000, 'a refusal backs off at least a day');
  db.close();
});

test('an agent-specific markdown variant is blocked, not silently parsed', async () => {
  // ramp.com does exactly this: text/markdown to any non-browser client.
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: { body: '# Acme — Machine Version\n\nAcme is a spend platform.', headers: { 'content-type': 'text/markdown' } },
  });
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };

  const r = await tick(E, { now: T(1), fetchImpl });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /non-HTML variant/);
  assert.equal(r.events, 0);
  db.close();
});

test('a network failure is recorded as an error and backs off', async () => {
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => { throw new Error('ECONNRESET'); },
  });
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };

  const r = await tick(E, { now: T(1), fetchImpl });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /ECONNRESET/);

  const f = (await db.prepare('SELECT * FROM fetches').all()).results[0];
  assert.equal(f.status, 'error');
  assert.ok(f.reason, 'the reason is stored, so the health page can say what went wrong');
  db.close();
});

test('a 5xx robots.txt means we never touch the page', async () => {
  const { db, fetchImpl } = env({
    [ROBOTS]: { status: 503, body: '' },
    [HOME]: DAY1,
  });
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };

  const r = await tick(E, { now: T(1), fetchImpl });
  assert.equal(r.status, 'blocked');
  assert.equal(fetchImpl.calls.filter((c) => c.url === HOME).length, 0, 'fail closed');
  db.close();
});

test('the crawler identifies itself on every request', async () => {
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: DAY1,
  });
  await tick({ DB: db, DAILY_CRON: 'x' }, { now: T(1), fetchImpl });

  assert.ok(fetchImpl.calls.length >= 2);
  for (const call of fetchImpl.calls) {
    assert.match(call.headers['user-agent'], /^PositioningIndexBot\/1\.0 \(\+https:/);
    assert.ok(call.headers.from, 'a From header carries the contact URL');
  }
  db.close();
});

test('one tick touches exactly one host', async () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO companies (slug, name, homepage_url, segment, added_at, active) VALUES
      ('a', 'A', 'https://a.test/', 'x', '2026-08-01T00:00:00Z', 1),
      ('b', 'B', 'https://b.test/', 'x', '2026-08-01T00:00:00Z', 1);
    INSERT INTO targets (company_id, kind, url, host, next_due_at, enabled) VALUES
      (1, 'home', 'https://a.test/', 'a.test', '2026-08-01T00:00:00Z', 1),
      (2, 'home', 'https://b.test/', 'b.test', '2026-08-01T00:00:00Z', 1);
  `);
  const fetchImpl = mockFetch({
    'https://a.test/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    'https://a.test/': DAY1,
    'https://b.test/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    'https://b.test/': DAY1,
  });

  await tick({ DB: db, DAILY_CRON: 'x' }, { now: T(1), fetchImpl });
  const hosts = new Set(fetchImpl.calls.map((c) => new URL(c.url).hostname));
  assert.equal(hosts.size, 1, 'a single invocation must never fan out across hosts');
  db.close();
});

test('the queue drains oldest-first and does not re-pick the same target', async () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO companies (slug, name, homepage_url, segment, added_at, active) VALUES
      ('a', 'A', 'https://a.test/', 'x', '2026-08-01T00:00:00Z', 1),
      ('b', 'B', 'https://b.test/', 'x', '2026-08-01T00:00:00Z', 1);
    INSERT INTO targets (company_id, kind, url, host, next_due_at, enabled) VALUES
      (1, 'home', 'https://a.test/', 'a.test', '2026-08-01T00:00:00Z', 1),
      (2, 'home', 'https://b.test/', 'b.test', '2026-08-01T01:00:00Z', 1);
  `);
  const routes = {};
  for (const h of ['a', 'b']) {
    routes[`https://${h}.test/robots.txt`] = { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } };
    routes[`https://${h}.test/`] = DAY1;
  }
  const fetchImpl = mockFetch(routes);
  const E = { DB: db, DAILY_CRON: 'x' };

  const first = await tick(E, { now: T(2), fetchImpl });
  const second = await tick(E, { now: T(2) + 300_000, fetchImpl });
  const third = await tick(E, { now: T(2) + 600_000, fetchImpl });

  assert.equal(first.slug, 'a', 'oldest due first');
  assert.equal(second.slug, 'b');
  assert.equal(third.action, 'idle', 'nothing left due; the tick is a no-op rather than a retry storm');
  db.close();
});

test('health never reports a silent failure as "no changes"', async () => {
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: { status: 500, body: 'boom' },
  });
  const E = { DB: db, DAILY_CRON: 'x' };
  // Wall-clock "now": indexStats uses datetime('now') windows, so the failure
  // has to be recent for the 24h counters to see it.
  await tick(E, { now: Date.now(), fetchImpl });

  const [h] = await companyHealth(db, { staleAfterHours: 48 });
  assert.notEqual(h.health, 'ok');
  assert.equal(h.health, 'stale', 'never successfully fetched, so it is stale, not healthy');
  assert.ok(h.last_reason, 'the specific reason is available to the public page');

  const stats = await indexStats(db);
  assert.equal(stats.changes, 0);
  assert.equal(stats.errors_24h > 0 || stats.blocked_24h > 0, true, 'the failure is visible in the index-wide counters');
  db.close();
});

test('daily bookkeeping closes the open run and starts a new one', async () => {
  const { db } = env({});
  const E = { DB: db, DAILY_CRON: '5 0 * * *' };
  const a = await daily(E, { now: T(1) });
  const b = await daily(E, { now: T(2) });
  assert.notEqual(a.runId, b.runId);

  const runs = (await db.prepare('SELECT * FROM runs ORDER BY id').all()).results;
  assert.equal(runs.length, 2);
  assert.ok(runs[0].closed_at, 'the previous run is closed, so the page can date the sweep');
  db.close();
});

test('companyDetail returns state, events and recent fetches together', async () => {
  let body = DAY1;
  const { db, fetchImpl } = env({
    [ROBOTS]: { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
    [HOME]: () => body,
  });
  const E = { DB: db, DAILY_CRON: 'x' };

  await tick(E, { now: T(1), fetchImpl });
  body = DAY3;
  await db.prepare("UPDATE targets SET next_due_at = '2026-08-03T00:00:00Z'").run();
  await tick(E, { now: T(3), fetchImpl });

  const detail = await companyDetail(db, 'acme');
  assert.equal(detail.company.slug, 'acme');
  assert.ok(detail.signals.length >= 5);
  assert.ok(detail.events.length >= 1);
  assert.equal(detail.fetches.length, 2);
  assert.equal(await companyDetail(db, 'nope'), null);
  db.close();
});

async function countEvents(db) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM change_events').first();
  return r.n;
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

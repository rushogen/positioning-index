/**
 * The storage layer's contract.
 *
 * Three properties are load-bearing and everything else in the project assumes
 * them:
 *
 *   1. Nothing is ever rewritten. Lines are only ever added to the end of a
 *      file, so a commit diff is always a list of new facts and never a
 *      wholesale replacement.
 *   2. A run always leaves a record, even when it did nothing. That is the only
 *      way "we looked and nothing had changed" can be told apart from "nobody
 *      ran the crawler for six weeks".
 *   3. An observation that repeats the previous one verbatim is not appended,
 *      but an observation whose parser-health counters moved IS -- otherwise
 *      de-duplication would quietly disable the removal rule in src/diff.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStore, observationFingerprint, queueFromRuns, iso } from '../src/store/files.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'positioning-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, 'data'));
  await store.init();
  return store;
}

const observation = (over = {}) => ({
  observed_at: '2026-08-01T00:00:00Z',
  slug: 'acme',
  kind: 'home',
  status: 'ok',
  reason: null,
  doc: { lang: 'en', canonical: null, variant: 'html', extractorVersion: '1.0.0' },
  signals: { headline: { value: 'A tool', hash: 'abc', method: 'h1', confidence: 1, json: null } },
  state: { headline: { last_good_at: '2026-08-01T00:00:00Z', last_good_value: 'A tool', consecutive_nulls: 0, suspect: 0 } },
  ...over,
});

test('files are append-only: an existing line is never rewritten', async (t) => {
  const store = await scratch(t);
  await store.appendObservation('acme', observation());
  const first = await readFile(join(store.root, 'companies', 'acme.ndjson'), 'utf8');

  await store.appendObservation('acme', observation({
    observed_at: '2026-08-02T00:00:00Z',
    signals: { headline: { value: 'A platform', hash: 'def', method: 'h1', confidence: 1, json: null } },
    state: { headline: { last_good_at: '2026-08-02T00:00:00Z', last_good_value: 'A platform', consecutive_nulls: 0, suspect: 0 } },
  }));
  const second = await readFile(join(store.root, 'companies', 'acme.ndjson'), 'utf8');

  assert.ok(second.startsWith(first), 'the previous content is a prefix of the new content');
  assert.equal(second.trimEnd().split('\n').length, 2);
});

test('one line per observation, valid JSON, no trailing garbage', async (t) => {
  const store = await scratch(t);
  await store.appendObservation('acme', observation());
  const raw = await readFile(join(store.root, 'companies', 'acme.ndjson'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  for (const line of raw.trimEnd().split('\n')) JSON.parse(line);
});

test('an identical re-observation is not appended', async (t) => {
  const store = await scratch(t);
  assert.equal(await store.appendObservation('acme', observation()), true);
  assert.equal(await store.appendObservation('acme', observation({ observed_at: '2026-08-02T00:00:00Z' })), false);
  assert.equal((await store.readCompany('acme')).length, 1);
});

test('a moving parser-health counter IS new information and is appended', async (t) => {
  const store = await scratch(t);
  await store.appendObservation('acme', observation());
  const fault = observation({
    observed_at: '2026-08-02T00:00:00Z',
    signals: { headline: null },
    state: { headline: { last_good_at: '2026-08-01T00:00:00Z', last_good_value: 'A tool', consecutive_nulls: 1, suspect: 0 } },
  });
  assert.equal(await store.appendObservation('acme', fault), true);

  const worse = { ...fault, observed_at: '2026-08-03T00:00:00Z' };
  worse.state = { headline: { ...fault.state.headline, consecutive_nulls: 2, suspect: 1 } };
  assert.equal(await store.appendObservation('acme', worse), true, 'nulls 1 -> 2 must reach the file or removals can never be confirmed');
  assert.equal((await store.readCompany('acme')).length, 3);
});

test('a signal that has never had a value does not churn the file', async (t) => {
  // linear.app publishes no logo wall this extractor can read, so the null
  // counter for customer_logos climbs on every run forever. It means nothing --
  // a removal cannot be confirmed for a value we never had -- and if it reached
  // the fingerprint every run would append an identical line.
  const store = await scratch(t);
  const never = (n) => observation({
    observed_at: `2026-08-0${n}T00:00:00Z`,
    signals: { ...observation().signals, customer_logos: null },
    state: {
      ...observation().state,
      customer_logos: { last_good_at: null, last_good_value: null, consecutive_nulls: n, suspect: 0 },
    },
  });
  assert.equal(await store.appendObservation('acme', never(1)), true);
  assert.equal(await store.appendObservation('acme', never(2)), false);
  assert.equal(await store.appendObservation('acme', never(3)), false);
  assert.equal((await store.readCompany('acme')).length, 1);
});

test('the two pages of one company de-duplicate independently', async (t) => {
  const store = await scratch(t);
  await store.appendObservation('acme', observation());
  await store.appendObservation('acme', observation({ kind: 'pricing' }));
  await store.appendObservation('acme', observation({ observed_at: '2026-08-02T00:00:00Z' }));
  assert.equal((await store.readCompany('acme')).length, 2);
  assert.equal((await store.lastObservation('acme', 'home')).kind, 'home');
  assert.equal((await store.lastObservation('acme', 'pricing')).kind, 'pricing');
});

test('the fingerprint ignores timestamps and nothing else', () => {
  const a = observation();
  const b = observation({ observed_at: '2030-01-01T00:00:00Z' });
  assert.equal(observationFingerprint(a), observationFingerprint(b));

  const c = observation({ status: 'changed-structure' });
  assert.notEqual(observationFingerprint(a), observationFingerprint(c));
});

test('an event is never published twice for the same signal at the same instant', async (t) => {
  const store = await scratch(t);
  const event = { detected_at: '2026-08-02T00:00:00Z', slug: 'acme', signal: 'headline', change_type: 'modified' };
  assert.equal(await store.appendEvents([event]), 1);
  assert.equal(await store.appendEvents([event]), 0, 're-running a crawl at the same timestamp is idempotent');
  assert.equal((await store.readEvents()).length, 1);
});

test('the crawl queue is a fold of the run ledger, not a file of its own', () => {
  const queue = queueFromRuns([
    { results: [{ slug: 'acme', kind: 'home', at: '2026-08-01T00:00:00Z', status: 'ok', next_due_at: '2026-08-02T00:00:00Z', etag: 'W/"1"', content_hash: 'aaa', failures: 0 }] },
    { results: [{ slug: 'acme', kind: 'home', at: '2026-08-02T00:00:00Z', status: 'error', reason: 'boom', next_due_at: '2026-08-02T00:15:00Z', failures: 1 }] },
  ]);
  const entry = queue.get('acme/home');
  assert.equal(entry.last_status, 'error');
  assert.equal(entry.last_attempted_at, '2026-08-02T00:00:00Z');
  assert.equal(entry.last_ok_at, '2026-08-01T00:00:00Z', 'a later failure does not erase the last success');
  assert.equal(entry.consecutive_failures, 1);
});

test('a truncated final line does not cost us the file', async (t) => {
  const store = await scratch(t);
  await store.appendObservation('acme', observation());
  const path = join(store.root, 'companies', 'acme.ndjson');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, '{"observed_at":"2026-08-02T00:0');

  const fresh = new FileStore(store.root);
  const rows = await fresh.readCompany('acme');
  assert.equal(rows.length, 1, 'the intact history survives an interrupted write');
});

test('iso truncates to whole seconds so ordering is lexicographic', () => {
  assert.equal(iso(Date.parse('2026-08-01T03:00:00.123Z')), '2026-08-01T03:00:00Z');
  assert.ok(iso(Date.parse('2026-08-01T03:00:00Z')) < iso(Date.parse('2026-08-01T03:00:01Z')));
});

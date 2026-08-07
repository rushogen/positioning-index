/**
 * Diff engine tests.
 *
 * The central property under test: a signal going from a value to null is a
 * PARSER FAILURE and must never produce a change event. Everything else in this
 * file exists to make sure that rule cannot be weakened by accident.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIDENCE_DROP, LIST_COLLAPSE_RATIO, RECENT_MEMORY, REMOVAL_CONFIRMATIONS, SUSPECT_AFTER,
  canonical, diffPage, diffSignal, editDistance, emptyState, gatePage, listDelta, textMagnitude,
} from '../src/diff.js';

const NOW = '2026-08-07T03:00:00Z';
const EARLIER = '2026-08-06T03:00:00Z';

const sig = (value, over = {}) =>
  value === null ? null : { value, method: 'h1', confidence: 1.0, json: undefined, ...over };

const stateWith = (value, over = {}) => ({
  ...emptyState('headline'),
  last_observed_at: EARLIER,
  last_good_at: EARLIER,
  last_good_value: value,
  last_good_hash: 'deadbeef',
  last_good_method: 'h1',
  last_good_confidence: 1.0,
  ...over,
});

// ---------------------------------------------------------------------------
// The core property
// ---------------------------------------------------------------------------

test('null where there was a value is a parser fault, not a change', () => {
  const r = diffSignal({
    signal: 'headline',
    current: null,
    state: stateWith('The issue tracking tool teams love'),
    pageHealthy: true,
    now: NOW,
  });

  assert.equal(r.outcome, 'parser-fault');
  assert.equal(r.event, null, 'a parser fault must never emit a change event');
  assert.equal(r.state.consecutive_nulls, 1);
  // The last known-good value survives, so tomorrow diffs against what we
  // actually believed rather than against the gap.
  assert.equal(r.state.last_good_value, 'The issue tracking tool teams love');
});

test('repeated nulls mark the signal suspect but still emit nothing', () => {
  let state = stateWith('The issue tracking tool teams love');
  for (let run = 1; run <= SUSPECT_AFTER; run++) {
    const r = diffSignal({ signal: 'headline', current: null, state, pageHealthy: true, now: NOW });
    assert.equal(r.event, null);
    state = r.state;
  }
  assert.equal(state.suspect, 1, `suspect must be set after ${SUSPECT_AFTER} null runs`);
  assert.equal(state.consecutive_nulls, SUSPECT_AFTER);
});

test('a value returning clears the fault and does not emit a change', () => {
  const state = stateWith('Plan and build products', { consecutive_nulls: 3, suspect: 1 });
  const r = diffSignal({ signal: 'headline', current: sig('Plan and build products'), state, pageHealthy: true, now: NOW });

  assert.equal(r.outcome, 'unchanged');
  assert.equal(r.event, null);
  assert.equal(r.state.suspect, 0);
  assert.equal(r.state.consecutive_nulls, 0);
});

test('a DIFFERENT value returning after a fault is reported as one change, not two', () => {
  const state = stateWith('Plan and build products', { consecutive_nulls: 3, suspect: 1 });
  const r = diffSignal({ signal: 'headline', current: sig('The system for product development'), state, pageHealthy: true, now: NOW });

  assert.equal(r.outcome, 'changed');
  assert.equal(r.event.change_type, 'modified');
  assert.equal(r.event.before_value, 'Plan and build products');
  assert.equal(r.event.after_value, 'The system for product development');
  // The gap did not become part of the story.
  assert.equal(r.event.previous_seen_at, EARLIER);
});

// ---------------------------------------------------------------------------
// Removal: allowed, but only under strict conditions
// ---------------------------------------------------------------------------

test('removal is only confirmed after sustained absence on a healthy page', () => {
  let state = stateWith('40% faster onboarding');
  const events = [];
  for (let run = 1; run <= REMOVAL_CONFIRMATIONS; run++) {
    const r = diffSignal({ signal: 'headline', current: null, state, pageHealthy: true, now: NOW });
    if (r.event) events.push({ run, ...r.event });
    state = r.state;
  }

  assert.equal(events.length, 1, 'exactly one removal event across the confirmation window');
  assert.equal(events[0].run, REMOVAL_CONFIRMATIONS, 'and not before the window closes');
  assert.equal(events[0].change_type, 'removed');
  assert.equal(events[0].before_value, '40% faster onboarding');
});

test('removal is never confirmed while the rest of the page is failing', () => {
  let state = stateWith('40% faster onboarding');
  for (let run = 1; run <= REMOVAL_CONFIRMATIONS * 2; run++) {
    const r = diffSignal({ signal: 'headline', current: null, state, pageHealthy: false, now: NOW });
    assert.equal(r.event, null, `run ${run} must stay silent when the page itself is unhealthy`);
    state = r.state;
  }
  assert.equal(state.last_good_value, '40% faster onboarding');
});

test('a confirmed removal is not re-emitted on subsequent runs', () => {
  let state = stateWith('30 day free trial');
  let seen = 0;
  for (let run = 1; run <= REMOVAL_CONFIRMATIONS * 3; run++) {
    const r = diffSignal({ signal: 'headline', current: null, state, pageHealthy: true, now: NOW });
    if (r.event) seen++;
    state = r.state;
  }
  assert.equal(seen, 1);
});

// ---------------------------------------------------------------------------
// Baselines and additions
// ---------------------------------------------------------------------------

test('first sighting establishes a baseline without emitting an event', () => {
  const r = diffSignal({ signal: 'headline', current: sig('Meet the new standard'), state: null, pageHealthy: true, now: NOW });
  assert.equal(r.outcome, 'baseline');
  assert.equal(r.event, null, 'day one of the index must not emit ~700 "added" events');
  assert.equal(r.state.last_good_value, 'Meet the new standard');
});

test('a signal that appears for the first time after we have history is an addition', () => {
  const state = { ...emptyState('pricing_seat_minimum'), last_observed_at: EARLIER, consecutive_nulls: 9 };
  const r = diffSignal({
    signal: 'pricing_seat_minimum',
    current: { value: '25 seats', method: 'regex:seat-minimum', confidence: 0.8 },
    state,
    pageHealthy: true,
    now: NOW,
  });
  assert.equal(r.outcome, 'added');
  assert.equal(r.event.change_type, 'added');
  assert.match(r.event.summary, /Introduced a seat minimum of 25 seats/);
});

// ---------------------------------------------------------------------------
// Attributing our own weakness to ourselves
// ---------------------------------------------------------------------------

test('a value change that arrives together with a confidence downgrade is suppressed', () => {
  const state = stateWith('The product development system', { last_good_method: 'h1', last_good_confidence: 1.0 });
  const r = diffSignal({
    signal: 'headline',
    current: { value: 'Linear – Plan and build products', method: 'og:title-fallback', confidence: 1.0 - CONFIDENCE_DROP - 0.1 },
    state,
    pageHealthy: true,
    now: NOW,
  });

  assert.equal(r.outcome, 'suppressed');
  assert.equal(r.event, null);
  assert.equal(r.state.suspect, 1);
  // Critically, the weak value does NOT become the new baseline.
  assert.equal(r.state.last_good_value, 'The product development system');
  assert.match(r.reason, /method downgraded/);
});

test('a value change on the same method at the same confidence is reported', () => {
  const state = stateWith('The product development system');
  const r = diffSignal({
    signal: 'headline',
    current: { value: 'The system for product development', method: 'h1', confidence: 1.0 },
    state,
    pageHealthy: true,
    now: NOW,
  });
  assert.equal(r.outcome, 'changed');
  assert.ok(r.event.magnitude > 0 && r.event.magnitude <= 1);
});

// ---------------------------------------------------------------------------
// List signals
// ---------------------------------------------------------------------------

const logoState = (names) => ({
  ...emptyState('customer_logos'),
  last_observed_at: EARLIER,
  last_good_at: EARLIER,
  last_good_value: names.join(', '),
  last_good_json: JSON.stringify({ names, count: names.length }),
  last_good_method: 'proof-region',
  last_good_confidence: 0.85,
});

test('a collapsing logo wall is suppressed as a selector break', () => {
  const before = ['Amazon', 'Cursor', 'Figma', 'OpenAI', 'Ramp', 'Scale', 'Shopify', 'Vercel'];
  const after = ['Figma', 'Vercel']; // 2/8 = 0.25, below LIST_COLLAPSE_RATIO
  assert.ok(after.length < before.length * LIST_COLLAPSE_RATIO, 'fixture must actually be below the threshold');

  const r = diffSignal({
    signal: 'customer_logos',
    current: { value: after.join(', '), method: 'proof-region', confidence: 0.85, json: { names: after, count: after.length } },
    state: logoState(before),
    pageHealthy: true,
    now: NOW,
  });

  assert.equal(r.outcome, 'suppressed');
  assert.equal(r.event, null);
  assert.equal(r.state.suspect, 1);
  assert.match(r.reason, /list collapsed 8 -> 2/);
});

test('a plausible logo swap is reported with the added and removed names', () => {
  const before = ['Amazon', 'Cursor', 'Figma', 'OpenAI', 'Ramp', 'Shopify'];
  const after = ['Amazon', 'Anthropic', 'Cursor', 'Figma', 'OpenAI', 'Shopify'];

  const r = diffSignal({
    signal: 'customer_logos',
    current: { value: after.join(', '), method: 'proof-region', confidence: 0.85, json: { names: after, count: after.length } },
    state: logoState(before),
    pageHealthy: true,
    now: NOW,
  });

  assert.equal(r.outcome, 'changed');
  assert.match(r.event.summary, /added Anthropic/);
  assert.match(r.event.summary, /removed Ramp/);
});

test('listDelta reports both directions and a bounded magnitude', () => {
  const d = listDelta(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(d.added, ['d']);
  assert.deepEqual(d.removed, ['a']);
  assert.ok(d.magnitude > 0 && d.magnitude < 1);
});

// ---------------------------------------------------------------------------
// A/B tests: a value the page has recently held is a rotation, not drift
// ---------------------------------------------------------------------------

test('a hero cycling between two variants is flagged as oscillating', () => {
  const A = 'AI transformed individual work. Acme transforms teamwork';
  const B = 'All your teams, all their workflows, connected in one workspace';

  // Day 1: baseline on A.
  let r = diffSignal({ signal: 'headline', current: sig(A), state: null, pageHealthy: true, now: NOW });
  let state = r.state;
  assert.equal(r.event, null);

  // Day 2: flips to B. We have never seen B, so this reports as a plain change.
  r = diffSignal({ signal: 'headline', current: sig(B), state, pageHealthy: true, now: NOW });
  state = r.state;
  assert.equal(r.outcome, 'changed');
  assert.equal(r.event.oscillating, 0, 'the first time a variant appears we cannot know it is a test');

  // Day 3: flips back to A. Now we know.
  r = diffSignal({ signal: 'headline', current: sig(A), state, pageHealthy: true, now: NOW });
  assert.equal(r.outcome, 'changed');
  assert.equal(r.event.oscillating, 1);
  assert.match(r.event.summary, /likely an A\/B test rather than a repositioning/);
});

test('memory of previous values is bounded', () => {
  let state = null;
  for (let i = 0; i < RECENT_MEMORY * 3; i++) {
    state = diffSignal({ signal: 'headline', current: sig(`Distinct headline number ${i}`), state, pageHealthy: true, now: NOW }).state;
  }
  assert.equal(JSON.parse(state.recent_hashes).length, RECENT_MEMORY);
});

test('a genuine one-way repositioning is never flagged as oscillating', () => {
  let state = diffSignal({ signal: 'headline', current: sig('The issue tracker teams love'), state: null, pageHealthy: true, now: NOW }).state;
  const r = diffSignal({ signal: 'headline', current: sig('The product development system for teams and agents'), state, pageHealthy: true, now: NOW });
  assert.equal(r.event.oscillating, 0);
  assert.doesNotMatch(r.event.summary, /A\/B/);
});

// ---------------------------------------------------------------------------
// Canonicalisation: typography churn is not positioning
// ---------------------------------------------------------------------------

test('smart quotes, en dashes and nbsp do not count as a change', () => {
  const before = 'The world’s best – and fastest – issue tracker';
  const after  = "The world's best - and fastest - issue tracker";
  assert.equal(canonical(before), canonical(after));

  const r = diffSignal({ signal: 'headline', current: sig(after), state: stateWith(before), pageHealthy: true, now: NOW });
  assert.equal(r.outcome, 'unchanged');
  assert.equal(r.event, null);
});

test('capitalisation IS a change -- it is an editorial decision', () => {
  const r = diffSignal({
    signal: 'headline',
    current: sig('The AI Workspace That Works For You'),
    state: stateWith('The AI workspace that works for you'),
    pageHealthy: true,
    now: NOW,
  });
  assert.equal(r.outcome, 'changed');
});

test('editDistance and textMagnitude behave', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('same', 'same'), 0);
  assert.equal(textMagnitude('abc', 'abc'), 0);
  assert.ok(textMagnitude('platform', 'system of record') > 0.5);
});

// ---------------------------------------------------------------------------
// Page-level gates
// ---------------------------------------------------------------------------

const extraction = (over = {}) => ({
  extractorVersion: '1.0.0',
  variant: 'html',
  extractable: true,
  lang: 'en',
  canonical: 'https://example.com/',
  signals: { headline: sig('a'), subhead: sig('b'), category_label: sig('c'), meta_title: sig('d') },
  ...over,
});

test('a failed fetch closes the gate', () => {
  const g = gatePage({ fetchOk: false, fetchReason: 'HTTP 503', extraction: extraction(), previous: {}, currentYield: 0, previousYield: 4 });
  assert.equal(g.diffable, false);
  assert.equal(g.status, 'error');
});

test('a non-HTML variant is blocked, not diffed', () => {
  const g = gatePage({
    fetchOk: true,
    extraction: extraction({ extractable: false, variant: 'agent-markdown' }),
    previous: {}, currentYield: 0, previousYield: 4,
  });
  assert.equal(g.diffable, false);
  assert.equal(g.status, 'blocked');
  assert.match(g.reason, /agent-markdown/);
});

test('a language switch is a locale shift, not drift', () => {
  const g = gatePage({
    fetchOk: true,
    extraction: extraction({ lang: 'de' }),
    previous: { lang: 'en', variant: 'html', extractorVersion: '1.0.0' },
    currentYield: 4, previousYield: 4,
  });
  assert.equal(g.diffable, false);
  assert.equal(g.rebaseline, true, 'we should re-baseline so tomorrow compares German with German');
  assert.match(g.reason, /locale shift/);
});

test('a collapse in signal yield is reported as changed-structure', () => {
  const g = gatePage({
    fetchOk: true,
    extraction: extraction(),
    previous: { lang: 'en', variant: 'html', extractorVersion: '1.0.0' },
    currentYield: 1, previousYield: 7,
  });
  assert.equal(g.diffable, false);
  assert.equal(g.status, 'changed-structure');
  assert.match(g.reason, /extractor needs review/);
});

test('bumping our own extractor version re-baselines instead of blaming the company', () => {
  const g = gatePage({
    fetchOk: true,
    extraction: extraction(),
    previous: { lang: 'en', variant: 'html', extractorVersion: '0.9.0' },
    currentYield: 4, previousYield: 4,
  });
  assert.equal(g.diffable, false);
  assert.equal(g.rebaseline, true);
  assert.match(g.reason, /re-baselining/);
});

test('a healthy page passes the gate', () => {
  const g = gatePage({
    fetchOk: true,
    extraction: extraction(),
    previous: { lang: 'en', variant: 'html', extractorVersion: '1.0.0', canonical: 'https://example.com/' },
    currentYield: 4, previousYield: 4,
  });
  assert.equal(g.diffable, true);
  assert.equal(g.status, 'ok');
});

// ---------------------------------------------------------------------------
// diffPage integration
// ---------------------------------------------------------------------------

test('when the gate is closed no events are produced even though every value differs', () => {
  const states = {
    headline: { ...stateWith('old headline'), signal: 'headline' },
    subhead: { ...stateWith('old subhead'), signal: 'subhead' },
    category_label: { ...stateWith('old category'), signal: 'category_label' },
    meta_title: { ...stateWith('old title'), signal: 'meta_title' },
  };
  const gate = { diffable: false, status: 'changed-structure', reason: 'page restructured', rebaseline: false };
  const { events, results } = diffPage({ extraction: extraction(), states, gate, now: NOW });

  assert.equal(events.length, 0);
  assert.ok(results.every((r) => r.outcome === 'suppressed'));
  // The observation is still recorded; only publication is withheld.
  assert.equal(results.length, 4);
});

test('when the gate is open real changes flow through', () => {
  const states = {
    headline: { ...stateWith('old headline'), signal: 'headline' },
    subhead: { ...stateWith('b'), signal: 'subhead' },
    category_label: { ...stateWith('c'), signal: 'category_label' },
    meta_title: { ...stateWith('d'), signal: 'meta_title' },
  };
  const gate = { diffable: true, status: 'ok', reason: null, rebaseline: false };
  const { events } = diffPage({ extraction: extraction(), states, gate, now: NOW });

  assert.equal(events.length, 1);
  assert.equal(events[0].signal, 'headline');
});

test('a page where most signals vanished is not healthy enough to confirm removals', () => {
  const states = Object.fromEntries(
    ['headline', 'subhead', 'category_label', 'meta_title'].map((s) => [s, { ...stateWith('x'), signal: s, consecutive_nulls: REMOVAL_CONFIRMATIONS - 1 }])
  );
  const mostlyNull = extraction({
    signals: { headline: sig('a'), subhead: null, category_label: null, meta_title: null },
  });
  const gate = { diffable: true, status: 'ok', reason: null, rebaseline: false };
  const { events, results, pageHealthy } = diffPage({ extraction: mostlyNull, states, gate, now: NOW });

  assert.equal(pageHealthy, false);

  // Three signals were one run away from the removal threshold and all three
  // went null. None of them may be published as a removal, because the page
  // itself is no longer trustworthy.
  assert.equal(events.filter((e) => e.change_type === 'removed').length, 0);
  assert.equal(
    results.filter((r) => r.outcome === 'parser-fault').length, 3,
    'they are recorded as parser faults instead'
  );

  // The one signal that did extract is still allowed to report a real change.
  assert.equal(events.length, 1);
  assert.equal(events[0].signal, 'headline');
  assert.equal(events[0].change_type, 'modified');
});

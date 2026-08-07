/**
 * Pricing extraction tests.
 *
 * The load-bearing case is the last section: when tier extraction fails, every
 * derived signal must be null rather than falsely confident. "No free tier
 * found" is a value, and publishing it on a run where our parser broke would
 * manufacture a headline change out of our own bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPricingSignals, extractSeatMinimum } from '../src/extract/pricing.js';
import { stripNonContent, collapse, text } from '../src/extract/html.js';
import { extract } from '../src/extract/index.js';
import { diffSignal, emptyState } from '../src/diff.js';

const page = (body) => `<!DOCTYPE html><html lang="en"><head><title>Pricing</title></head><body>${body}</body></html>`;
const run = (body) => {
  const doc = stripNonContent(page(body));
  return extractPricingSignals(doc, page(body), collapse(text(doc)));
};

const TABLE = `
  <section class="pricing">
    <div class="plan"><h3>Free</h3><p>$0</p><p>For individuals getting started</p></div>
    <div class="plan"><h3>Basic</h3><p>$10 per user per month</p></div>
    <div class="plan"><h3>Business</h3><p>$16 per user per month</p></div>
    <div class="plan"><h3>Enterprise</h3><p>Contact sales for custom pricing</p></div>
  </section>`;

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('reads tier names, prices, period and seat unit', () => {
  const out = run(TABLE);
  const names = out.pricing_tiers.json.tiers.map((t) => t.name);
  assert.deepEqual(names, ['Free', 'Basic', 'Business', 'Enterprise']);

  const basic = out.pricing_tiers.json.tiers.find((t) => t.name === 'Basic');
  assert.equal(basic.amount, 10);
  assert.equal(basic.currency, 'USD');
  assert.equal(basic.unit, 'user');
  assert.equal(basic.period, 'month');
});

test('the seat unit and the billing period are never conflated', () => {
  const v = run(TABLE).pricing_tiers.value;
  assert.ok(v.includes('Basic USD 10/user/month'), v);
  assert.ok(!/\/user\/user/.test(v), 'the period must not be filled in with the seat unit');
});

test('entry price is the cheapest non-zero tier', () => {
  const out = run(TABLE);
  assert.equal(out.pricing_entry_price.json.amount, 10);
  assert.equal(out.pricing_entry_price.json.tier, 'Basic');
});

test('a contact-sales tier is recorded with no price rather than skipped', () => {
  const ent = run(TABLE).pricing_tiers.json.tiers.find((t) => t.name === 'Enterprise');
  assert.equal(ent.amount, null);
  assert.ok(run(TABLE).pricing_tiers.value.includes('Enterprise custom'));
});

test('free tier detection', () => {
  assert.equal(run(TABLE).pricing_free_tier.value, 'yes');

  const noFree = `
    <section>
      <div class="plan"><h3>Starter</h3><p>$29 per month</p></div>
      <div class="plan"><h3>Growth</h3><p>$99 per month</p></div>
      <div class="plan"><h3>Enterprise</h3><p>Contact sales</p></div>
    </section>`;
  assert.equal(run(noFree).pricing_free_tier.value, 'no');
});

test('marketing badges are stripped from tier names', () => {
  const out = run(`
    <section>
      <div class="plan"><h3>Free</h3><p>$0</p></div>
      <div class="plan"><h3>Business Most Popular</h3><p>$19 per month</p></div>
      <div class="plan"><h3>Enterprise</h3><p>Contact sales</p></div>
    </section>`);
  assert.ok(out.pricing_tiers.json.tiers.some((t) => t.name === 'Business'), out.pricing_tiers.value);
});

test('European price formatting is parsed correctly', () => {
  const out = run(`
    <section>
      <div class="plan"><h3>Free</h3><p>0 €</p></div>
      <div class="plan"><h3>Plus</h3><p>9,50 € pro Monat</p></div>
      <div class="plan"><h3>Business</h3><p>19,50 €</p></div>
    </section>`);
  const plus = out.pricing_tiers.json.tiers.find((t) => t.name === 'Plus');
  assert.equal(plus.amount, 9.5, 'a comma is the decimal separator here, not a thousands separator');
  assert.equal(plus.currency, 'EUR');
});

test('a thousands separator is not read as a decimal point', () => {
  const out = run(`
    <section>
      <div class="plan"><h3>Starter</h3><p>$1,200 per year</p></div>
      <div class="plan"><h3>Business</h3><p>$4,800 per year</p></div>
    </section>`);
  assert.equal(out.pricing_tiers.json.tiers[0].amount, 1200);
});

test('JSON-LD offers win over the heuristic when present', () => {
  const ld = `<script type="application/ld+json">{
    "@type":"Product","name":"Acme",
    "offers":[{"@type":"Offer","name":"Team","price":"12","priceCurrency":"USD"},
              {"@type":"Offer","name":"Business","price":"24","priceCurrency":"USD"}]}</script>`;
  const out = run(ld + TABLE);
  assert.equal(out.pricing_tiers.method, 'json-ld:offers');
  assert.equal(out.pricing_tiers.confidence, 0.95);
  assert.deepEqual(out.pricing_tiers.json.tiers.map((t) => t.name), ['Team', 'Business']);
});

// ---------------------------------------------------------------------------
// seat minimums
// ---------------------------------------------------------------------------

test('recognises several seat-minimum phrasings', () => {
  const cases = [
    ['Enterprise plans require a minimum of 25 seats.', '25 seats'],
    ['Billed annually, 10 seats minimum.', '10 seats'],
    ['Starts at 5 users on the Business plan.', '5 users'],
    ['You will be billed for a minimum of 3 seats.', '3 seats'],
  ];
  for (const [copy, expected] of cases) {
    assert.equal(extractSeatMinimum(copy)?.value, expected, copy);
  }
});

test('no seat minimum yields null, and null is not a claim', () => {
  assert.equal(extractSeatMinimum('Pay per user, cancel anytime.'), null);
});

test('an implausible seat count is rejected', () => {
  assert.equal(extractSeatMinimum('a minimum of 99999 seats'), null);
});

// ---------------------------------------------------------------------------
// THE load-bearing property: derived signals collapse to null together
// ---------------------------------------------------------------------------

test('when tier extraction fails, every derived signal is null -- not "no"', () => {
  // A client-rendered pricing page: the tier table never reaches the HTML.
  // This is not hypothetical -- vercel.com/pricing behaves exactly this way.
  const clientRendered = page('<h1>Pricing</h1><div id="root"></div><p>Find a plan to power your projects.</p>');
  const doc = stripNonContent(clientRendered);
  const out = extractPricingSignals(doc, clientRendered, collapse(text(doc)));

  assert.equal(out.pricing_tiers, null);
  assert.equal(out.pricing_entry_price, null);
  assert.equal(
    out.pricing_free_tier, null,
    'a null free-tier signal is honest; "no" would be a fabricated claim that the free plan was removed'
  );
});

test('a single stray price is not a pricing table', () => {
  const out = run('<h2>Enterprise</h2><p>Starting at $500 a month, talk to sales.</p>');
  assert.equal(out.pricing_tiers, null, 'one tier is a stray currency symbol, not a published table');
  assert.equal(out.pricing_free_tier, null);
});

test('the free-tier null propagates through the diff engine as a parser fault', () => {
  // Yesterday: a healthy pricing page that published a free tier.
  const state = {
    ...emptyState('pricing_free_tier'),
    last_observed_at: '2026-08-06T03:00:00Z',
    last_good_at: '2026-08-06T03:00:00Z',
    last_good_value: 'yes',
    last_good_method: 'heuristic:anchor+price',
    last_good_confidence: 0.7,
  };

  // Today: the page went client-rendered and we extracted nothing.
  const clientRendered = page('<h1>Pricing</h1><div id="root"></div>');
  const doc = stripNonContent(clientRendered);
  const today = extractPricingSignals(doc, clientRendered, collapse(text(doc)));

  const r = diffSignal({
    signal: 'pricing_free_tier',
    current: today.pricing_free_tier,
    state,
    pageHealthy: false,
    now: '2026-08-07T03:00:00Z',
  });

  assert.equal(r.outcome, 'parser-fault');
  assert.equal(r.event, null, 'this is the exact false headline the project exists to avoid');
  assert.equal(r.state.last_good_value, 'yes', 'the last thing we believed survives the gap');
});

test('a genuine free-tier removal still reports, once the page is readable', () => {
  const state = {
    ...emptyState('pricing_free_tier'),
    last_observed_at: '2026-08-06T03:00:00Z',
    last_good_at: '2026-08-06T03:00:00Z',
    last_good_value: 'yes',
    last_good_method: 'heuristic:anchor+price',
    last_good_confidence: 0.7,
  };

  const withoutFree = `
    <section>
      <div class="plan"><h3>Starter</h3><p>$29 per month</p></div>
      <div class="plan"><h3>Growth</h3><p>$99 per month</p></div>
      <div class="plan"><h3>Enterprise</h3><p>Contact sales</p></div>
    </section>`;
  const today = run(withoutFree);
  assert.equal(today.pricing_free_tier.value, 'no');

  const r = diffSignal({ signal: 'pricing_free_tier', current: today.pricing_free_tier, state, pageHealthy: true, now: '2026-08-07T03:00:00Z' });
  assert.equal(r.outcome, 'changed');
  assert.equal(r.event.summary, 'Free tier no longer published');
});

// ---------------------------------------------------------------------------
// end to end through the orchestrator
// ---------------------------------------------------------------------------

test('extract("pricing") wires the derived signals together', () => {
  const out = extract('pricing', page(TABLE), 'https://example.com/pricing');
  assert.equal(out.signals.pricing_free_tier.value, 'yes');
  assert.equal(out.signals.pricing_entry_price.json.amount, 10);
  assert.equal(out.signals.pricing_meta_title.value, 'Pricing');

  const broken = extract('pricing', page('<div id="root"></div>'), 'https://example.com/pricing');
  assert.equal(broken.signals.pricing_tiers, null);
  assert.equal(broken.signals.pricing_free_tier, null);
  assert.equal(broken.signals.pricing_meta_title.value, 'Pricing', 'unrelated signals still work');
});

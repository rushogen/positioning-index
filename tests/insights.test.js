/**
 * Cross-sectional aggregation tests.
 *
 * The load-bearing cases are the ones about absence. Every function in
 * src/insights.js turns 60 companies into a number, and the only way that
 * number lies is by treating "we could not read it" as "it is not there". A
 * pricing page we failed to parse must never land in the "no free tier" bar; a
 * company with no headline must never contribute a zero to a word count. Those
 * are the tests below that would matter if someone refactored this file in a
 * hurry, and they are written as such.
 *
 * The rest pin the grouping rules, which are choices rather than facts and
 * should therefore be hard to change silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aiMentions, aiTermsIn, categoryNounOf, categoryNouns, headlineWords, logoMentions,
  pricingShape, proofClaims, signalStatus, stateOfPositioning, tokenize, STOPWORDS,
} from '../src/insights.js';
import { barChart, escapeHtml, stackChart } from '../src/charts.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A signal state block, in the shape src/store/files.js folds one into. */
const sig = (value, extra = {}) => ({
  last_good_value: value,
  last_good_json: null,
  last_good_method: 'test',
  last_good_at: '2026-08-07T00:00:00Z',
  suspect: 0,
  consecutive_nulls: 0,
  total_changes: 0,
  ...extra,
});

/** A signal state block carrying a structured payload. */
const listSig = (json, extra = {}) => sig(JSON.stringify(json).slice(0, 40), { last_good_json: JSON.stringify(json), ...extra });

/**
 * @param {{slug: string, name: string, home?: object, pricing?: object}[]} entries
 */
function model(entries) {
  return {
    companies: entries.map((e) => ({ slug: e.slug, name: e.name, segment: e.segment ?? 'test' })),
    series: new Map(entries.map((e) => [e.slug, [
      { kind: 'home', state: e.home ?? {} },
      { kind: 'pricing', state: e.pricing ?? {} },
    ]])),
  };
}

// ---------------------------------------------------------------------------
// tokenising and stopwords
// ---------------------------------------------------------------------------

test('tokenising splits on punctuation and drops anything under three letters', () => {
  assert.deepEqual(
    tokenize('The AI-powered, go-to-market OS for teams.'),
    ['the', 'powered', 'market', 'for', 'teams']
  );
});

test('"ai" is excluded by the length rule, not by a special case', () => {
  assert.ok(!tokenize('AI for everyone').includes('ai'));
  assert.ok(!STOPWORDS.has('ai'), 'excluding it as a stopword would hide the rule that does it');
});

test('contractions decompose rather than surviving as junk tokens', () => {
  // "you're" -> "you" + a two-letter tail that the length rule removes.
  assert.deepEqual(tokenize("You're finally moving in"), ['you', 'finally', 'moving']);
});

test('stopwords are removed from the word count', () => {
  const { words } = headlineWords(model([
    { slug: 'a', name: 'A', home: { headline: sig('The platform for the teams that ship') } },
    { slug: 'b', name: 'B', home: { headline: sig('A platform with teams') } },
  ]));
  const found = words.map((w) => w.word);
  assert.deepEqual(found.slice(0, 2), ['platform', 'teams']);
  for (const stopword of ['the', 'for', 'that', 'with']) {
    assert.ok(!found.includes(stopword), `"${stopword}" should have been removed`);
  }
});

test('a repeated word votes once, because the unit is the company', () => {
  const { words } = headlineWords(model([
    { slug: 'a', name: 'A', home: { headline: sig('Revenue, revenue, revenue') } },
    { slug: 'b', name: 'B', home: { headline: sig('Grow revenue') } },
  ]));
  assert.equal(words.find((w) => w.word === 'revenue').n, 2);
});

test('nothing is stemmed: agent and agents are counted apart', () => {
  const { words } = headlineWords(model([
    { slug: 'a', name: 'A', home: { headline: sig('An agent for support') } },
    { slug: 'b', name: 'B', home: { headline: sig('Teams and agents') } },
    { slug: 'c', name: 'C', home: { headline: sig('Humans and agents') } },
  ]));
  assert.equal(words.find((w) => w.word === 'agents').n, 2);
  assert.equal(words.find((w) => w.word === 'agent').n, 1);
});

test('a company with no headline is unreadable, never a zero', () => {
  const out = headlineWords(model([
    { slug: 'a', name: 'A', home: { headline: sig('Ship faster') } },
    { slug: 'b', name: 'B', home: {} },
  ]));
  assert.equal(out.coverage.tracked, 2);
  assert.equal(out.coverage.readable, 1);
  assert.equal(out.coverage.unreadable, 1);
  assert.deepEqual(out.coverage.missing, [{ slug: 'b', name: 'B' }]);
  assert.equal(out.words.find((w) => w.word === 'faster').n, 1);
});

test('every word carries the headlines behind it, so the grouping is checkable', () => {
  const { words } = headlineWords(model([
    { slug: 'linear', name: 'Linear', home: { headline: sig('The system for teams and agents') } },
  ]));
  assert.deepEqual(words.find((w) => w.word === 'agents').companies, [
    { slug: 'linear', name: 'Linear', text: 'The system for teams and agents' },
  ]);
});

// ---------------------------------------------------------------------------
// category grouping
// ---------------------------------------------------------------------------

test('the head noun is the first one in the label, read left to right', () => {
  assert.equal(categoryNounOf('ai platform for marketers'), 'platform');
  assert.equal(categoryNounOf('crm for agentic revenue'), 'crm');
  assert.equal(categoryNounOf('os for human-agent teams'), 'os');
  assert.equal(categoryNounOf('one platform for your apps'), 'platform');
});

test('"agentic" is not the noun "agent"', () => {
  assert.equal(categoryNounOf('agentic infrastructure'), 'infrastructure');
  assert.equal(categoryNounOf('autonomous agents'), 'agent');
});

test('singular and plural are one group here, unlike in the word count', () => {
  assert.equal(categoryNounOf('ai agents'), 'agent');
  assert.equal(categoryNounOf('an ai agent'), 'agent');
  assert.equal(categoryNounOf('vibe-coded apps'), 'app');
});

test('a label with no noun we know is reported, not forced into a bucket', () => {
  assert.equal(categoryNounOf('sales'), null);

  const out = categoryNouns(model([
    { slug: 'a', name: 'A', home: { category_label: sig('ai platform for marketers') } },
    { slug: 'b', name: 'B', home: { category_label: sig('sales') } },
  ]));
  assert.deepEqual(out.groups.map((g) => [g.noun, g.n]), [['platform', 1]]);
  assert.deepEqual(out.unmatched, [{ slug: 'b', name: 'B', text: 'sales' }]);
  assert.equal(out.coverage.readable, 2, 'an unmatched label was still read');
});

test('groups sort by size, then alphabetically, so the output is stable', () => {
  const out = categoryNouns(model([
    { slug: 'a', name: 'A', home: { category_label: sig('one workspace') } },
    { slug: 'b', name: 'B', home: { category_label: sig('a crm') } },
    { slug: 'c', name: 'C', home: { category_label: sig('the platform') } },
    { slug: 'd', name: 'D', home: { category_label: sig('another platform') } },
  ]));
  assert.deepEqual(out.groups.map((g) => g.noun), ['platform', 'crm', 'workspace']);
});

// ---------------------------------------------------------------------------
// AI mention detection
// ---------------------------------------------------------------------------

test('AI terms match whole tokens, so "said" is not a mention', () => {
  assert.deepEqual(aiTermsIn('AI-powered service'), ['ai']);
  assert.deepEqual(aiTermsIn('He said the chain would hold'), []);
  assert.deepEqual(aiTermsIn('Agentic autonomy'), ['agent', 'autonomous']);
  assert.deepEqual(aiTermsIn('Your copilot'), ['copilot']);
  assert.deepEqual(aiTermsIn(null), []);
});

test('a mention anywhere in the three fields counts the company once', () => {
  const out = aiMentions(model([
    { slug: 'a', name: 'A', home: { headline: sig('Ship faster'), subhead: sig('Now with AI agents'), category_label: sig('a platform') } },
  ]));
  assert.equal(out.mentions.length, 1);
  assert.deepEqual(out.mentions[0].terms, ['agent', 'ai']);
  assert.deepEqual(out.mentions[0].fields, ['subhead']);
  assert.deepEqual(out.by_term.map((t) => [t.term, t.n]), [['agent', 1], ['ai', 1]]);
});

test('unreadable is a third number, never folded into "does not mention"', () => {
  const out = aiMentions(model([
    { slug: 'a', name: 'A', home: { headline: sig('An AI platform') } },
    { slug: 'b', name: 'B', home: { headline: sig('Just software') } },
    { slug: 'c', name: 'C', home: {} },
  ]));
  assert.equal(out.mentions.length, 1);
  assert.equal(out.quiet.length, 1, 'the unreadable company must not be counted as quiet');
  assert.equal(out.coverage.readable, 2);
  assert.equal(out.coverage.unreadable, 1);
  assert.equal(
    out.mentions.length + out.quiet.length + out.coverage.unreadable,
    out.coverage.tracked,
    'the three buckets must account for every tracked company exactly once'
  );
});

test('the per-field counts may exceed the company count, and that is the point', () => {
  const out = aiMentions(model([
    { slug: 'a', name: 'A', home: { headline: sig('AI for teams'), subhead: sig('AI for everyone') } },
  ]));
  assert.equal(out.mentions.length, 1);
  assert.deepEqual(out.by_field.map((f) => [f.field, f.n]), [
    ['headline', 1], ['subhead', 1], ['category_label', 0],
  ]);
});

// ---------------------------------------------------------------------------
// pricing -- nulls excluded, never zeroed
// ---------------------------------------------------------------------------

test('an unreadable pricing page is not a company without a free tier', () => {
  const out = pricingShape(model([
    { slug: 'a', name: 'A', pricing: { pricing_free_tier: sig('yes') } },
    { slug: 'b', name: 'B', pricing: { pricing_free_tier: sig('no') } },
    { slug: 'c', name: 'C', pricing: {} },
  ]));
  assert.equal(out.free_tier.yes.length, 1);
  assert.equal(out.free_tier.no.length, 1, 'only an actual "no" is a no');
  assert.equal(out.free_tier.coverage.readable, 2);
  assert.equal(out.free_tier.coverage.unreadable, 1);
  assert.deepEqual(out.free_tier.coverage.missing, [{ slug: 'c', name: 'C' }]);
});

test('a missing entry price is excluded from the buckets and the median, not counted as 0', () => {
  const out = pricingShape(model([
    { slug: 'a', name: 'A', pricing: { pricing_entry_price: listSig({ amount: 10, currency: 'USD', tier: 'Plus' }) } },
    { slug: 'b', name: 'B', pricing: { pricing_entry_price: listSig({ amount: 30, currency: 'USD', tier: 'Pro' }) } },
    { slug: 'c', name: 'C', pricing: {} },
  ]));

  assert.equal(out.entry_price.coverage.readable, 2);
  assert.equal(out.entry_price.median, 10, 'the median is over the two readable prices, not three');

  const under = out.entry_price.buckets.find((b) => b.key === 'under-1');
  assert.equal(under.n, 0, 'a company with no price must not land in the cheapest bucket');
  assert.equal(out.entry_price.buckets.reduce((sum, b) => sum + b.n, 0), 2);
});

test('bucket boundaries are half-open, so a price lands in exactly one', () => {
  const out = pricingShape(model([
    { slug: 'a', name: 'A', pricing: { pricing_entry_price: listSig({ amount: 0.99, currency: 'USD' }) } },
    { slug: 'b', name: 'B', pricing: { pricing_entry_price: listSig({ amount: 1, currency: 'USD' }) } },
    { slug: 'c', name: 'C', pricing: { pricing_entry_price: listSig({ amount: 10, currency: 'USD' }) } },
    { slug: 'd', name: 'D', pricing: { pricing_entry_price: listSig({ amount: 100, currency: 'USD' }) } },
  ]));
  assert.deepEqual(
    out.entry_price.buckets.filter((b) => b.n).map((b) => [b.key, b.n]),
    [['under-1', 1], ['1-9', 1], ['10-19', 1], ['100-plus', 1]]
  );
});

test('currencies are reported rather than converted', () => {
  const out = pricingShape(model([
    { slug: 'a', name: 'A', pricing: { pricing_entry_price: listSig({ amount: 10, currency: 'USD' }) } },
    { slug: 'b', name: 'B', pricing: { pricing_entry_price: listSig({ amount: 10, currency: 'EUR' }) } },
  ]));
  assert.deepEqual(out.entry_price.currencies, [
    { currency: 'EUR', n: 1 }, { currency: 'USD', n: 1 },
  ]);
});

test('a tier with no price is recorded as a contact-sales tier, not dropped', () => {
  const out = pricingShape(model([
    {
      slug: 'a',
      name: 'A',
      pricing: {
        pricing_tiers: listSig({
          tiers: [
            { name: 'Plus', amount: 10, source: 'heuristic' },
            { name: 'Enterprise', amount: null, source: 'contact-sales' },
          ],
        }),
      },
    },
  ]));
  assert.equal(out.tiers.coverage.readable, 1);
  assert.deepEqual(out.tiers.contact_sales, [{ slug: 'a', name: 'A', text: 'Enterprise' }]);
});

// ---------------------------------------------------------------------------
// proof points
// ---------------------------------------------------------------------------

test('proof points count companies, not claims, and merge the two percent forms', () => {
  const out = proofClaims(model([
    {
      slug: 'a',
      name: 'A',
      home: {
        proof_points: listSig({
          items: [
            { claim: '40% faster', kind: 'percent' },
            { claim: 'cut costs by 30%', kind: 'percent-trailing' },
            { claim: '20,000 teams', kind: 'count' },
          ],
        }),
      },
    },
    {
      slug: 'b',
      name: 'B',
      home: { proof_points: listSig({ items: [{ claim: '500 companies', kind: 'count' }] }) },
    },
  ]));

  const percent = out.kinds.find((k) => k.key === 'percent');
  assert.equal(percent.n, 1, 'one company, however many percentage claims it makes');
  assert.equal(percent.claims, 2, 'both percent forms land in the same category');
  assert.equal(out.kinds.find((k) => k.key === 'count').n, 2);
  assert.equal(out.total_claims, 4);
  assert.equal(out.coverage.readable, 2);
});

test('a company with no proof points is unreadable, not a company that proves nothing', () => {
  const out = proofClaims(model([
    { slug: 'a', name: 'A', home: { proof_points: listSig({ items: [{ claim: '10x', kind: 'multiplier' }] }) } },
    { slug: 'b', name: 'B', home: {} },
  ]));
  assert.equal(out.coverage.readable, 1);
  assert.deepEqual(out.coverage.missing, [{ slug: 'b', name: 'B' }]);
});

// ---------------------------------------------------------------------------
// customer logos
// ---------------------------------------------------------------------------

test('logo counting is case-folded, and the display spelling is the most common', () => {
  const out = logoMentions(model([
    { slug: 'a', name: 'A', home: { customer_logos: listSig({ names: ['OpenAI', 'Figma'] }) } },
    { slug: 'b', name: 'B', home: { customer_logos: listSig({ names: ['OpenAI'] }) } },
    { slug: 'c', name: 'C', home: { customer_logos: listSig({ names: ['openai'] }) } },
  ]));
  const openai = out.logos.find((l) => l.key === 'openai');
  assert.equal(openai.n, 3);
  assert.equal(openai.logo, 'OpenAI', 'two pages spell it this way and one does not');
});

test('a tie on spelling is broken by collation, not by which file was read first', () => {
  const forwards = logoMentions(model([
    { slug: 'a', name: 'A', home: { customer_logos: listSig({ names: ['Zebra'] }) } },
    { slug: 'b', name: 'B', home: { customer_logos: listSig({ names: ['ZEBRA'] }) } },
  ]));
  const backwards = logoMentions(model([
    { slug: 'b', name: 'B', home: { customer_logos: listSig({ names: ['ZEBRA'] }) } },
    { slug: 'a', name: 'A', home: { customer_logos: listSig({ names: ['Zebra'] }) } },
  ]));
  assert.equal(forwards.logos[0].logo, backwards.logos[0].logo);
  assert.equal(forwards.logos[0].logo, 'Zebra', 'en collation, pinned so the build is portable');
});

test('a logo listed twice on one page counts that page once', () => {
  const out = logoMentions(model([
    { slug: 'a', name: 'A', home: { customer_logos: listSig({ names: ['Slack', 'slack', 'SLACK'] }) } },
  ]));
  assert.equal(out.logos.find((l) => l.key === 'slack').n, 1);
});

test('a page with no readable logo wall is unreadable, not a page with no customers', () => {
  const out = logoMentions(model([
    { slug: 'a', name: 'A', home: { customer_logos: listSig({ names: ['Figma'] }) } },
    { slug: 'b', name: 'B', home: {} },
  ]));
  assert.equal(out.coverage.readable, 1);
  assert.equal(out.coverage.unreadable, 1);
});

// ---------------------------------------------------------------------------
// freshness -- the difference between "51" and "52, one of which we could not
// read this morning"
// ---------------------------------------------------------------------------

test('a value retained after a parser fault is counted, and declared as held', () => {
  const m = model([
    { slug: 'a', name: 'A', home: { category_label: sig('one workspace', { consecutive_nulls: 1 }) } },
    { slug: 'b', name: 'B', home: { category_label: sig('a platform') } },
  ]);
  assert.equal(signalStatus(m.series.get('a')[0].state, 'category_label'), 'held');
  assert.equal(signalStatus(m.series.get('b')[0].state, 'category_label'), 'fresh');

  const out = categoryNouns(m);
  assert.equal(out.coverage.readable, 2);
  assert.equal(out.coverage.held, 1);
  assert.equal(out.coverage.suspect, 0);
});

test('a suspect signal is declared as suspect rather than as merely held', () => {
  const m = model([
    { slug: 'a', name: 'A', pricing: { pricing_tiers: listSig({ tiers: [{ name: 'Plus', amount: 9 }] }, { suspect: 1, consecutive_nulls: 3 }) } },
  ]);
  assert.equal(signalStatus(m.series.get('a')[1].state, 'pricing_tiers'), 'suspect');
  assert.equal(pricingShape(m).tiers.coverage.suspect, 1);
});

test('signalStatus reports nothing at all where there is no value', () => {
  assert.equal(signalStatus({}, 'headline'), null);
  assert.equal(signalStatus({ headline: sig(null) }, 'headline'), null);
});

// ---------------------------------------------------------------------------
// determinism -- the build must produce identical bytes twice
// ---------------------------------------------------------------------------

test('the whole bundle is deterministic and ties break alphabetically', () => {
  const m = model([
    { slug: 'z', name: 'Zeta', home: { headline: sig('Build with agents'), category_label: sig('a platform') } },
    { slug: 'a', name: 'Alpha', home: { headline: sig('Build with teams'), category_label: sig('a platform') } },
    { slug: 'm', name: 'Mu', home: { headline: sig('Ship with agents'), category_label: sig('a system') } },
  ]);

  const first = stateOfPositioning(m);
  const second = stateOfPositioning(m);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // "agents" and "build" and "with"-minus-stopword all tie at 2; alphabetical.
  const tied = first.headline_words.words.filter((w) => w.n === 2).map((w) => w.word);
  assert.deepEqual(tied, [...tied].sort());

  // Companies inside a bucket are ordered by name, not by insertion.
  assert.deepEqual(
    first.category_nouns.groups[0].companies.map((c) => c.name),
    ['Alpha', 'Zeta']
  );
});

// ---------------------------------------------------------------------------
// chart rendering -- a headline is data we display, never markup we run
// ---------------------------------------------------------------------------

test('a headline containing markup is escaped, in the label and in the title', () => {
  const svg = barChart({ rows: [{ label: '<script>alert(1)</script>', n: 1, note: 'a "quoted" note' }] });
  assert.ok(!svg.includes('<script>'), svg);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('title="a &quot;quoted&quot; note"'));
  assert.equal(escapeHtml(`<a href='x'>&</a>`), '&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;');
});

test('a zero draws no bar at all, and still prints its zero', () => {
  const svg = barChart({ rows: [{ label: 'nothing', n: 0 }, { label: 'something', n: 4 }] });
  const bars = svg.match(/<rect class="bar-fill"/g) ?? [];
  assert.equal(bars.length, 2, 'only the non-zero row draws (fill plus its squared baseline end)');
  assert.ok(svg.includes('<span class="bar-value">0</span>'));
});

test('bars are scaled against the largest value and expressed as percentages', () => {
  const svg = barChart({ rows: [{ label: 'a', n: 10 }, { label: 'b', n: 5 }] });
  assert.ok(svg.includes('width="100%"'), 'the largest bar fills the track');
  assert.ok(svg.includes('width="50%"'));
  assert.ok(!/viewBox/.test(svg), 'a viewBox would scale the whole coordinate system on a phone');
});

test('stacked segments run to the right edge so only the outer corners round', () => {
  const svg = stackChart({
    segments: [
      { label: 'yes', n: 30, tone: 'lead' },
      { label: 'no', n: 10, tone: 'quiet' },
    ],
  });
  assert.ok(svg.includes('x="0%" y="0" width="100%"'), svg);
  assert.ok(svg.includes('x="75%" y="0" width="25%"'), svg);
  // The boundary is a gap in the surface colour, never a border on the mark.
  assert.ok(svg.includes('class="seg-gap"'));
  assert.ok(!svg.includes('stroke'), 'marks are separated by the gap, not by a stroke');
  // Every segment's count is text in the legend, which is what licenses the
  // recessive tone on the "not readable" segment.
  assert.ok(svg.includes('<b>30</b> yes'));
  assert.ok(svg.includes('<b>10</b> no'));
});

test('an empty segment is left out of the bar but kept in the legend', () => {
  const svg = stackChart({
    segments: [
      { label: 'yes', n: 3, tone: 'lead' },
      { label: 'not readable', n: 0, tone: 'none' },
    ],
  });
  assert.ok(!svg.includes('class="seg none"'), 'nothing is drawn for a zero');
  assert.ok(svg.includes('<b>0</b> not readable'), 'but the reader is still told it is zero');
});

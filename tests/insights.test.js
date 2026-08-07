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
import { readFile } from 'node:fs/promises';

import {
  aiMentions, aiTermsIn, categoryNounOf, categoryNouns, flipsToTie, groupOfSegment, headlineWords,
  logoMentions, pricingShape, proofClaims, segmentBreakdown, signalStatus, stateOfPositioning,
  tokenize, FRAGILE_FLIPS, MIN_CELL_N, MIN_GROUPS_DRAWN, SEGMENT_GROUPS, STOPWORDS,
} from '../src/insights.js';
import { barChart, escapeHtml, shareBars, stackChart } from '../src/charts.js';

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
// segment grouping -- the fold, the floor, and the width of a difference
//
// This is the part of the file most likely to be quietly wrong, because every
// failure mode looks like a working chart. A cell of two renders as a bar. An
// unreadable pricing page renders as a company without a free tier. A ranking
// whose first two entries are one company apart renders as a ranking. The tests
// below are the ones that would catch each of those.
// ---------------------------------------------------------------------------

/** One company in a seed segment. `headline: undefined` means "not readable". */
function co(segment, i, headline) {
  return {
    slug: `${segment}-${i}`,
    name: `${segment} ${String(i).padStart(2, '0')}`,
    segment,
    home: headline === undefined ? {} : { headline: sig(headline) },
  };
}

/** @param {Record<string, (string|undefined)[]>} spec segment -> one headline per company */
function segModel(spec) {
  return model(Object.entries(spec).flatMap(([segment, headlines]) =>
    headlines.map((h, i) => co(segment, i, h))));
}

const AI = 'An AI platform for teams';
const PLAIN = 'Software for teams';
const cutNamed = (out, key) => out.cuts.find((c) => c.key === key);
const cellNamed = (cut, group) => cut.cells.find((c) => c.group === group);

test('every seed segment maps into exactly one group, and no group claims two', () => {
  const seen = new Map();
  for (const group of SEGMENT_GROUPS) {
    for (const segment of group.segments) {
      assert.ok(!seen.has(segment), `${segment} is claimed by ${seen.get(segment)} and ${group.key}`);
      seen.set(segment, group.key);
      assert.equal(groupOfSegment(segment), group.key);
    }
  }
  assert.equal(groupOfSegment('not-a-segment'), null);
});

test('the mapping covers the real seed file, so a new segment cannot go missing', async () => {
  const seed = JSON.parse(await readFile(new URL('../seed/companies.json', import.meta.url), 'utf8'));
  const unmapped = seed.companies.filter((c) => groupOfSegment(c.segment) === null);
  assert.deepEqual(unmapped.map((c) => c.slug), [], 'a seeded segment with no group is invisible on the site');

  const out = segmentBreakdown({ companies: seed.companies, series: new Map() });
  assert.deepEqual(out.ungrouped, []);
  assert.equal(
    out.groups.reduce((sum, g) => sum + g.n, 0),
    seed.companies.length,
    'the groups must partition the seed: no company dropped, none counted twice'
  );
});

test('a company whose segment we do not know is reported, never silently dropped', () => {
  const out = segmentBreakdown(segModel({ 'dev-infra': [AI], 'quantum-toaster': [AI] }));
  assert.deepEqual(out.ungrouped, [{ slug: 'quantum-toaster-0', name: 'quantum-toaster 00', text: 'quantum-toaster' }]);
  assert.equal(out.coverage.tracked, 2);
  assert.equal(out.coverage.readable, 1);
});

test('a null in a segment cell is unreadable, never counted as a no', () => {
  const out = segmentBreakdown(segModel({
    'dev-infra': [AI, AI, AI, AI, PLAIN, PLAIN, undefined, undefined, undefined],
  }));
  const cell = cellNamed(cutNamed(out, 'ai'), 'dev');

  assert.equal(cell.n, 9);
  assert.equal(cell.readable, 6, 'three unreadable companies leave the denominator');
  assert.equal(cell.yes, 4);
  assert.equal(cell.no, 2, 'an unreadable headline is not a company that avoids AI language');
  assert.equal(cell.unreadable, 3);
  assert.equal(cell.yes + cell.no, cell.readable);
  assert.equal(cell.yes + cell.no + cell.unreadable, cell.n, 'every company is in exactly one bucket');
  assert.equal(cell.share, 66.7, 'the share is over the six we read, not the nine we tracked');
  assert.deepEqual(cell.companies.unreadable.map((c) => c.slug), ['dev-infra-6', 'dev-infra-7', 'dev-infra-8']);
});

test(`a cell under ${MIN_CELL_N} readable is suppressed and carries no percentage at all`, () => {
  const out = segmentBreakdown(segModel({
    'dev-infra': Array(MIN_CELL_N).fill(AI),
    analytics: Array(MIN_CELL_N - 1).fill(AI),
  }));
  const cut = cutNamed(out, 'ai');

  const big = cellNamed(cut, 'dev');
  assert.equal(big.suppressed, false);
  assert.equal(big.share, 100);

  const small = cellNamed(cut, 'data');
  assert.equal(small.readable, MIN_CELL_N - 1);
  assert.equal(small.suppressed, true);
  assert.ok(!('share' in small), 'a suppressed cell must have no percentage for a renderer to reach for');
  assert.ok(!cut.ranked.includes(small), 'and must be out of the ranking the chart draws');
});

test('suppression counts readable companies, not companies in the group', () => {
  // Twelve companies, five of them readable: a big group is not a big cell.
  const out = segmentBreakdown(segModel({
    'dev-infra': [AI, AI, AI, PLAIN, PLAIN, ...Array(7).fill(undefined)],
  }));
  const cell = cellNamed(cutNamed(out, 'ai'), 'dev');
  assert.equal(cell.n, 12);
  assert.equal(cell.readable, 5);
  assert.equal(cell.suppressed, true);
});

test('flipsToTie is the number of companies a difference is worth', () => {
  // 15 of 15 against 10 of 12: two of the twelve get it to 100%, one does not.
  assert.equal(flipsToTie({ yes: 15, readable: 15 }, { yes: 10, readable: 12 }), 2);
  // 7 of 10 (70%) against 3 of 6 (50%): 4/6 is 67%, still short; 5/6 clears it.
  assert.equal(flipsToTie({ yes: 7, readable: 10 }, { yes: 3, readable: 6 }), 2);
  // A whole group flipping is the widest a difference can be.
  assert.equal(flipsToTie({ yes: 8, readable: 8 }, { yes: 0, readable: 9 }), 9);
  // Equal shares, and a "low" that is already higher, are both zero rather than
  // negative -- the caller asks how far apart they are, not which way round.
  assert.equal(flipsToTie({ yes: 3, readable: 6 }, { yes: 5, readable: 10 }), 0);
  assert.equal(flipsToTie({ yes: 1, readable: 10 }, { yes: 9, readable: 10 }), 0);
  assert.equal(flipsToTie({ yes: 1, readable: 0 }, { yes: 1, readable: 6 }), null);
  assert.equal(flipsToTie(null, { yes: 1, readable: 6 }), null);
});

test(`a cut whose ends are within ${FRAGILE_FLIPS} companies is withheld, not drawn with a caveat`, () => {
  const six = (yes) => Array(6).fill(null).map((_, i) => (i < yes ? AI : PLAIN));
  // One segment per group, so every group is drawable and the cut is withheld
  // on fragility rather than on coverage.
  const out = segmentBreakdown(segModel({
    'dev-infra': six(3), analytics: six(3), 'product-dev': six(3), gtm: six(4), support: six(3),
    grc: six(3), erp: six(3), 'hr-ops': six(3), payments: six(3), industrial: six(3),
  }));
  const cut = cutNamed(out, 'ai');

  assert.equal(cut.spread, 1, 'one company separates the best group from the worst');
  assert.equal(cut.drawn, false);
  assert.deepEqual(cut.withheld, { rule: 'flat', spread: 1 });
  assert.ok(out.withheld.includes('ai'));
});

test('a cut with a real spread survives, and reports how wide it is', () => {
  const six = (yes) => Array(6).fill(null).map((_, i) => (i < yes ? AI : PLAIN));
  const out = segmentBreakdown(segModel({
    'dev-infra': six(6), analytics: six(6), 'product-dev': six(5), gtm: six(5), support: six(5),
    grc: six(5), erp: six(5), 'hr-ops': six(0), payments: six(5), industrial: six(5),
  }));
  const cut = cutNamed(out, 'ai');

  assert.equal(cut.drawn, true);
  assert.equal(cut.withheld, null);
  assert.equal(cut.top.yes, 6);
  assert.equal(cut.bottom.yes, 0);
  assert.equal(cut.spread, 6, 'all six of the bottom group would have to change');
  assert.equal(cut.lead_over_runner_up, 0, 'the top two are level, and the copy has to be able to say so');
});

test(`a cut fewer than ${MIN_GROUPS_DRAWN} groups can support is withheld on coverage, before fragility`, () => {
  // Two groups readable and big, the other eight too small: a two-group
  // comparison of a two-hundred-company set is not a segment breakdown.
  const out = segmentBreakdown(segModel({
    'dev-infra': Array(8).fill(AI),
    analytics: Array(8).fill(PLAIN),
    'product-dev': [AI, undefined, undefined],
    gtm: [PLAIN, undefined, undefined],
    support: [AI, undefined],
    grc: [PLAIN, undefined],
    erp: [AI, undefined],
    'hr-ops': [AI, undefined],
    payments: [PLAIN, undefined],
    industrial: [AI, undefined],
  }));
  const cut = cutNamed(out, 'ai');

  assert.equal(cut.drawn, false);
  assert.equal(cut.withheld.rule, 'coverage', 'coverage is checked first, so the reason is stable');
  assert.equal(cut.withheld.drawable, 2);
  assert.equal(cut.withheld.groups, 10);
  // The spread is enormous -- 8 of 8 against 0 of 8 -- and it still does not
  // rescue a cut that only two groups can answer.
  assert.equal(cut.spread, 8);
});

test('the ranking is by share, not by count, so unequal groups compare honestly', () => {
  const out = segmentBreakdown(segModel({
    // 6 of 6 beats 8 of 12, even though eight is the bigger number.
    'dev-infra': Array(6).fill(AI),
    'product-dev': [...Array(8).fill(AI), ...Array(4).fill(PLAIN)],
  }));
  const cut = cutNamed(out, 'ai');
  assert.deepEqual(cut.ranked.map((c) => [c.group, c.yes, c.readable]), [['dev', 6, 6], ['work', 8, 12]]);
});

test('a proof cut reads the claim kinds, and a page with no claims is unreadable', () => {
  const withProof = (segment, i, kinds) => ({
    slug: `${segment}-${i}`,
    name: `${segment} ${String(i).padStart(2, '0')}`,
    segment,
    home: kinds === undefined
      ? {}
      : { proof_points: listSig({ items: kinds.map((k) => ({ claim: 'x', kind: k })) }) },
  });

  const out = segmentBreakdown(model([
    ...Array(4).fill(null).map((_, i) => withProof('dev-infra', i, ['count'])),
    ...Array(2).fill(null).map((_, i) => withProof('dev-infra', i + 4, ['time'])),
    withProof('dev-infra', 6, undefined),
  ]));

  const counts = cellNamed(cutNamed(out, 'proof-count'), 'dev');
  assert.equal(counts.n, 7);
  assert.equal(counts.readable, 6, 'the company with no readable claims leaves the denominator');
  assert.equal(counts.yes, 4);
  assert.equal(counts.no, 2, 'a company that proves things another way is a real no');
  assert.equal(counts.unreadable, 1);
});

test('the two percent claim kinds stay merged when cut by segment', () => {
  const proof = (segment, i, kind) => ({
    slug: `${segment}-${i}`,
    name: `${segment} ${String(i).padStart(2, '0')}`,
    segment,
    home: { proof_points: listSig({ items: [{ claim: 'x', kind }] }) },
  });
  const out = segmentBreakdown(model([
    proof('dev-infra', 0, 'percent'),
    proof('dev-infra', 1, 'percent-trailing'),
  ]));
  assert.equal(cellNamed(cutNamed(out, 'proof-percent'), 'dev').yes, 2);
  assert.ok(!out.cuts.some((c) => c.key === 'proof-percent-trailing'), 'our regexes are not a market category');
});

test('an unreadable pricing page never lands in a segment as "no free tier"', () => {
  const out = segmentBreakdown(model([
    { slug: 'a', name: 'A', segment: 'dev-infra', pricing: { pricing_free_tier: sig('yes') } },
    { slug: 'b', name: 'B', segment: 'dev-infra', pricing: { pricing_free_tier: sig('no') } },
    { slug: 'c', name: 'C', segment: 'dev-infra', pricing: {} },
  ]));
  const cell = cellNamed(cutNamed(out, 'free-tier'), 'dev');
  assert.equal(cell.yes, 1);
  assert.equal(cell.no, 1);
  assert.equal(cell.unreadable, 1);
  assert.equal(cell.suppressed, true, 'and two readable pages is nowhere near enough to draw');
});

test('the breakdown is deterministic and ties inside it break by label', () => {
  const m = segModel({
    'dev-infra': Array(6).fill(AI),
    analytics: Array(6).fill(AI),
    'product-dev': Array(6).fill(PLAIN),
  });
  const first = segmentBreakdown(m);
  const second = segmentBreakdown(m);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // Dev & infrastructure and Data & analytics are both 6 of 6; alphabetical.
  const cut = cutNamed(first, 'ai');
  assert.deepEqual(cut.ranked.slice(0, 2).map((c) => c.label), ['Data & analytics', 'Developer & infrastructure']);
});

// ---------------------------------------------------------------------------
// share bars -- the n is on the bar, and a suppressed cell draws nothing
// ---------------------------------------------------------------------------

test('every share bar states its count and denominator inline, with the percentage', () => {
  const svg = shareBars({ rows: [{ label: 'Finance & people', part: 4, whole: 6, of: 7 }] });
  assert.ok(svg.includes('<b>4 of 6</b>'), 'the n rides on the bar, not in a tooltip or a footnote');
  assert.ok(svg.includes('>67%</span>'), svg);
  assert.ok(
    svg.indexOf('<b>4 of 6</b>') < svg.indexOf('>67%</span>'),
    'the percentage follows the counts that produced it and never travels alone'
  );
  // The mark is 66.67% wide and the text says 67%: the geometry keeps the
  // precision that makes the build byte-stable, the reader is not shown it.
  assert.ok(svg.includes('width="66.67%"'));
  assert.ok(!/viewBox/.test(svg), 'a viewBox would halve the label size on a phone');
});

test('a share bar is scaled against its own denominator, never against the other bars', () => {
  const svg = shareBars({ rows: [
    { label: 'a', part: 6, whole: 6, of: 6 },
    { label: 'b', part: 8, whole: 16, of: 16 },
  ] });
  assert.ok(svg.includes('class="bar-fill" x="0" y="2" width="100%"'), 'six of six fills the rail');
  assert.ok(svg.includes('class="bar-fill" x="0" y="2" width="50%"'), 'eight of sixteen is half of it');
  // The rail is the visible 100%, so a percentage has something to be read against.
  assert.equal((svg.match(/class="share-rail"/g) ?? []).length, 2);
});

test('a suppressed cell draws no mark and says why, keeping its row', () => {
  const svg = shareBars({ rows: [
    { label: 'Work & product', part: 13, whole: 13, of: 16 },
    { label: 'Finance & people', part: 1, whole: 2, of: 7, suppressed: true },
  ] });
  assert.ok(svg.includes('too few to say &mdash; 2 of 7 readable'));
  assert.equal((svg.match(/class="bar-fill"/g) ?? []).length, 2, 'only the drawable row draws (fill plus baseline end)');
  assert.ok(!svg.includes('50%'), 'a cell too small to draw is also too small to quote a percentage for');
  assert.ok(svg.includes('Finance &amp; people'), 'the group keeps its row: vanishing reads as scoring zero');
});

test('a share of zero draws the rail and no fill, and still prints its zero', () => {
  const svg = shareBars({ rows: [{ label: 'Go-to-market', part: 0, whole: 15, of: 15 }] });
  assert.ok(!svg.includes('class="bar-fill"'), 'nothing is drawn for none of them');
  assert.ok(svg.includes('class="share-rail"'), 'but the denominator is still visible');
  assert.ok(svg.includes('<b>0 of 15</b>'));
  assert.ok(svg.includes('>0%</span>'));
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

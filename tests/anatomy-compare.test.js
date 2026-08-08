/**
 * One page against the corpus.
 *
 * The interesting cases here are all absences: a page we could not read, a
 * signal nothing in the corpus reports, a section deeper than the published
 * profile goes, a peer list longer than it is allowed to print. Every one of
 * them is a place where a plausible-looking wrong answer is easy to produce,
 * which is why they are the ones pinned.
 *
 * The last test is the general one: it walks everything either function returns
 * and fails on any percentage that is not standing next to the n that produced
 * it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_TYPES } from '../src/extract/anatomy.js';
import {
  CLASSIFIER_ACCURACY,
  PEER_LIMIT,
  TYPE_LABEL,
  TYPE_PHRASE,
  accuracyBlock,
  classifierCaveat,
  pageInsight,
  peerBlock,
  sectionInsight,
} from '../src/anatomy-compare.js';

// --------------------------------------------------------------- the fixture

// A miniature of what pageAnatomy() returns, computed the same way
// anatomy-insights.js computes it, so a test that passes here is not passing
// against a shape the real model never produces.

const pct = (n, of) => (of === 0 ? null : Math.round((n / of) * 1000) / 10);

function quantiles(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, min: s[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: s.at(-1) };
}

function coverageOf(rows, readable) {
  const missing = rows.filter((r) => !readable(r)).map((r) => ({ slug: r.slug, name: r.name }));
  return {
    tracked: rows.length,
    readable: rows.length - missing.length,
    unreadable: missing.length,
    held: 0,
    suspect: 0,
    missing: missing.sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

const SCALE_SIGNALS = [
  ['anatomy_section_count', 'Sections on the page', (c) => (c.sections ? c.sections.length : null)],
  ['anatomy_cta_count', 'Calls to action', (c) => c.cta_count],
  ['anatomy_nav_links', 'Links in the nav', (c) => c.nav_links],
  ['anatomy_footer_links', 'Links in the footer', (c) => c.footer_links],
  ['anatomy_word_count', 'Words on the page', (c) => c.words],
  ['anatomy_form_fields', 'Form fields', () => null],
];

function makeAnatomy(companies, { depth = 8 } = {}) {
  const rows = companies.slice().sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const readable = rows.filter((r) => r.sections);

  const positions = [];
  for (let i = 0; i < depth; i++) {
    const at = readable.map((r) => ({ r, type: r.sections[i]?.type ?? null })).filter((x) => x.type);
    if (!at.length) break;
    const counts = new Map();
    for (const { r, type } of at) {
      if (!counts.has(type)) counts.set(type, []);
      counts.get(type).push({ slug: r.slug, name: r.name });
    }
    positions.push({
      position: i + 1,
      n: at.length,
      types: [...counts.entries()]
        .map(([type, cos]) => ({
          type,
          n: cos.length,
          share: pct(cos.length, at.length),
          companies: cos.sort((a, b) => a.name.localeCompare(b.name, 'en')),
        }))
        .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
    });
  }

  const elements = SECTION_TYPES.filter((t) => t !== 'hero' && t !== 'other')
    .map((type) => {
      const has = readable.filter((r) => r.sections.some((s) => s.type === type));
      return {
        type,
        n: has.length,
        of: readable.length,
        share: pct(has.length, readable.length),
        companies: has.map((r) => ({ slug: r.slug, name: r.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'en')),
      };
    })
    .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type));

  const scales = SCALE_SIGNALS.map(([signal, label, get]) => {
    const withValue = rows.map((r) => ({ r, v: get(r) })).filter((x) => typeof x.v === 'number');
    return {
      signal,
      label,
      // Spread of null adds nothing, which is exactly what anatomy-insights.js
      // does: a scale nobody could be read for has no `n` key at all.
      ...quantiles(withValue.map((x) => x.v)),
      coverage: coverageOf(rows, (r) => typeof get(r) === 'number'),
      extremes: {
        lowest: withValue.slice().sort((a, b) => a.v - b.v).slice(0, 5)
          .map((x) => ({ slug: x.r.slug, name: x.r.name, value: x.v })),
        highest: withValue.slice().sort((a, b) => b.v - a.v).slice(0, 5)
          .map((x) => ({ slug: x.r.slug, name: x.r.name, value: x.v })),
      },
    };
  });

  const sections = readable.reduce((t, r) => t + r.sections.length, 0);
  const other = readable.reduce((t, r) => t + r.sections.filter((s) => s.type === 'other').length, 0);

  return {
    quality: { sections, other, named: sections - other, other_share: pct(other, sections) },
    positions: { positions, coverage: coverageOf(rows, (r) => r.sections) },
    elements: { elements, coverage: coverageOf(rows, (r) => r.sections) },
    scales: { scales },
    companies: rows,
    vocabulary: SECTION_TYPES,
  };
}

const seq = (types, words = 100) =>
  types.map((type, i) => ({ position: i + 1, type, heading: i ? `${type} heading` : null, words: words + i }));

/** Twelve lookalikes, one deep page, one page we could not read. */
function corpus() {
  const followers = Array.from({ length: 12 }, (_, i) => ({
    slug: `c${String(i + 1).padStart(2, '0')}`,
    name: `Company ${String(i + 1).padStart(2, '0')}`,
    segment: 'smb',
    sections: seq(['hero', 'features', 'cta']),
    words: 400 + i * 10,
    nav_links: null,
    footer_links: 20 + i,
    cta_count: 2,
  }));

  const acme = {
    slug: 'acme',
    name: 'Acme',
    segment: 'enterprise',
    // Eleven sections: deeper than the published profile's eight.
    sections: seq([
      'hero', 'features', 'proof', 'testimonial', 'pricing',
      'faq', 'logos', 'integrations', 'security', 'resources', 'cta',
    ], 120),
    words: 1499,
    nav_links: null,
    footer_links: 64,
    cta_count: 7,
  };

  const dark = {
    slug: 'darkpage',
    name: 'Darkpage',
    segment: 'enterprise',
    sections: null,          // rule 1: not readable, not a page without sections
    words: 900,
    nav_links: null,
    footer_links: null,
    cta_count: null,
  };

  return makeAnatomy([acme, ...followers, dark]);
}

const anatomy = corpus();
const acme = anatomy.companies.find((c) => c.slug === 'acme');
const dark = anatomy.companies.find((c) => c.slug === 'darkpage');

// -------------------------------------------------------------- the fixture holds

test('the fixture reproduces the shapes this module is written against', () => {
  assert.equal(anatomy.positions.positions.length, 8, 'the published profile stops at eight');
  assert.equal(anatomy.positions.coverage.unreadable, 1, 'the unreadable page is named, not dropped');
  const nav = anatomy.scales.scales.find((s) => s.signal === 'anatomy_nav_links');
  assert.equal(nav.n, undefined, 'a scale with nothing readable has no n key at all');
});

// ------------------------------------------------- a section past the profile

test('a section deeper than the published profile is answered, and says where the answer came from', () => {
  const out = sectionInsight({ section: 11, company: 'acme', anatomy });

  assert.equal(out.position, 11);
  assert.equal(out.type, 'cta');
  assert.equal(out.typeLabel, 'Call to action');
  assert.equal(out.present, true);

  const note = out.notes.find((n) => n.code === 'beyond-published-depth');
  assert.ok(note, 'the reader is told the corpus profile does not reach this far');
  assert.match(note.text, /stops at position 8/);

  const slot = out.judged.find((j) => j.key === 'same_type_here');
  assert.equal(slot.of, 1, 'one page in this corpus reaches position 11');
  assert.equal(slot.basis.source, 'strips', 're-derived rather than withheld');

  assert.equal(out.peers.n, 0);
  assert.equal(out.peers.omitted, 0);
  assert.match(out.peers.note, /No other/);

  // The measured half still works at any depth, because counting does not
  // depend on anyone else's page.
  const words = out.measured.find((m) => m.key === 'words');
  assert.equal(words.value, 130);
  assert.match(words.comparison, /11 sections on this page/);
  assert.equal(words.caveat, null, 'a word count is not a judgement');
});

test('the shallow-position case still uses the published profile', () => {
  const out = sectionInsight({ section: 2, company: 'acme', anatomy });
  const slot = out.judged.find((j) => j.key === 'slot_convention');
  assert.equal(slot.basis.source, 'positions');
  assert.equal(slot.of, 13, 'thirteen readable pages reach position 2');
  assert.equal(out.notes.find((n) => n.code === 'beyond-published-depth'), undefined);
});

// -------------------------------------------------------- a page we cannot read

test('a company with no readable sequence is an extraction gap, never a page with no sections', () => {
  const out = sectionInsight({ section: 2, company: 'darkpage', anatomy });

  assert.equal(out.readable, false);
  assert.equal(out.present, false);
  assert.equal(out.type, null);
  assert.deepEqual(out.measured, [], 'nothing is invented to fill the row');
  assert.deepEqual(out.judged, []);
  assert.equal(out.peers.n, 0);

  const note = out.notes.find((n) => n.code === 'no-readable-sequence');
  assert.ok(note);
  assert.match(note.text, /not h2-headed/);
  assert.match(note.text, /not a page built without sections/);
  assert.doesNotMatch(note.text, /\b0 sections\b/, 'unreadable is never rendered as zero');
});

test('the same page still gets its counted measures, because those are not in doubt', () => {
  const out = pageInsight({ company: dark, anatomy });

  assert.equal(out.readable, true);
  assert.equal(out.sequenceReadable, false);
  assert.equal(out.sections, null);
  assert.deepEqual(out.judged, [], 'no sequence means no judged claims about one');

  const words = out.measured.find((m) => m.key === 'word_count');
  assert.equal(words.value, 900, 'the word count read even though the sequence did not');
  assert.ok(words.comparison, 'and it is placed in the distribution');

  const count = out.measured.find((m) => m.key === 'section_count');
  assert.equal(count.value, null);
  assert.match(count.note, /did not extract/);
  assert.match(count.note, /not a page with none/);

  assert.match(out.notes.find((n) => n.code === 'no-readable-sequence').text, /13 of 14/);
});

// ------------------------------------------------------------ a scale with n=0

test('a scale nothing is readable for produces a null and a reason, not a zero', () => {
  const out = pageInsight({ company: acme, anatomy });
  const nav = out.measured.find((m) => m.key === 'nav_links');

  assert.equal(nav.value, null);
  assert.equal(nav.comparison, null);
  assert.equal(nav.placement, null);
  assert.deepEqual(nav.distribution, { n: 0, min: null, p25: null, median: null, p75: null, max: null });
  assert.match(nav.note, /no distribution/);
  assert.match(nav.note, /Not readable, not zero/);
  assert.equal(nav.coverage.readable, 0);
  assert.equal(nav.coverage.tracked, 14);
});

test('a page is placed in the distribution, never graded', () => {
  const out = pageInsight({ company: 'acme', anatomy });
  const words = out.measured.find((m) => m.key === 'word_count');

  assert.equal(words.value, 1499);
  assert.equal(words.placement.band, 'above-p75');
  assert.match(words.comparison, /^1,499 words, above the p75 of \d+ across 14 readable pages$/);
  assert.equal(words.rank.place, 1);
  assert.equal(words.rank.of, 14);
  assert.match(words.rank.text, /the highest of 14 readable pages/);

  const forbidden = /\b(too (long|short|many|few)|should|better|worse|good|bad|poor|optimal|ideal|bloated)\b/i;
  for (const m of out.measured) {
    for (const s of [m.comparison, m.note, m.placement?.text, m.rank?.text]) {
      if (s) assert.doesNotMatch(s, forbidden, `graded language in: ${s}`);
    }
  }
});

// --------------------------------------------------------------- peer capping

test('a capped peer list reports how many it is not showing', () => {
  const out = sectionInsight({ section: 2, company: 'acme', anatomy });

  assert.equal(out.peers.n, 12, 'twelve other pages have a feature grid at position 2');
  assert.equal(out.peers.shown, PEER_LIMIT);
  assert.equal(out.peers.companies.length, PEER_LIMIT);
  assert.equal(out.peers.omitted, 12 - PEER_LIMIT);
  assert.equal(out.peers.truncated, true);
  assert.match(out.peers.note, /8 of 12 listed, sorted by name; 4 not listed here/);
  assert.match(out.peers.note, /Excludes Acme\./);

  assert.deepEqual(
    out.peers.companies.map((c) => c.name),
    ['Company 01', 'Company 02', 'Company 03', 'Company 04',
      'Company 05', 'Company 06', 'Company 07', 'Company 08'],
    'sorted by name, so the same eight appear on every build',
  );
  assert.ok(!out.peers.companies.some((c) => c.slug === 'acme'), 'a page is not its own peer');
});

test('the counts behind a capped list are the full counts, not the printed ones', () => {
  const out = sectionInsight({ section: 2, company: 'acme', anatomy });
  const mine = out.judged.find((j) => j.key === 'same_type_here');
  assert.equal(mine.n, 13, 'all thirteen, including Acme');
  assert.equal(mine.of, 13);
  assert.match(mine.value, /13 of 13 \(100%\)/);
  assert.equal(mine.companies.shown, PEER_LIMIT, 'while the list beside it prints eight');
});

test('an uncapped list is still described as what it is', () => {
  const block = peerBlock([{ slug: 'b', name: 'Beta' }, { slug: 'a', name: 'Alpha' }]);
  assert.deepEqual(block.companies.map((c) => c.name), ['Alpha', 'Beta']);
  assert.equal(block.truncated, false);
  assert.equal(block.omitted, 0);
  assert.match(block.note, /All 2 listed/);
});

// ------------------------------------------------------------- measured/judged

test('measured and judged are separate lists, and only one of them carries the caveat', () => {
  const s = sectionInsight({ section: 3, company: 'acme', anatomy });
  const p = pageInsight({ company: acme, anatomy });

  assert.ok(s.measured.length && s.judged.length);
  for (const m of [...s.measured, ...p.measured]) {
    assert.equal(m.kind, 'measured');
    assert.equal(m.caveat, null, `${m.key} is counted off the page and needs no caveat`);
  }
  for (const j of [...s.judged, ...p.judged]) {
    assert.equal(j.kind, 'judged');
    assert.equal(typeof j.caveat, 'string');
    assert.ok(j.caveat.length > 100, `${j.key} carries the caveat inline, not by reference`);
    assert.equal(j.accuracy.nonHeroOf, CLASSIFIER_ACCURACY.non_hero);
  }
});

test('the caveat is generated from the scored counts, so it cannot claim a score nobody measured', () => {
  const real = classifierCaveat();
  assert.match(real, /43 of 126 \(34\.1%\)/);
  assert.match(real, /84 of 168 \(50%\)/);
  assert.match(real, /44 hand-labelled pages/);

  const invented = classifierCaveat({
    ...CLASSIFIER_ACCURACY, non_hero: 200, non_hero_correct: 150, matched: 300, correct: 240,
  });
  assert.match(invented, /150 of 200 \(75%\)/);
  assert.doesNotMatch(invented, /43 of 126/, 'nothing here is typed next to the numbers');

  const block = accuracyBlock();
  assert.equal(block.nonHero, 0.34);
  assert.equal(block.overall, 0.5);
  assert.equal(block.source, 'scripts/score-anatomy.js against seed/labels.json');
});

test('every type in the published vocabulary has a label and a noun phrase', () => {
  for (const t of SECTION_TYPES) {
    assert.equal(typeof TYPE_LABEL[t], 'string', `${t} has no label`);
    assert.match(TYPE_PHRASE[t] ?? '', /^an? /, `${t} has no article-carrying phrase`);
  }
});

test('the generated sentences are English, which a lowercased label is not', () => {
  // "put a unclassified here" and "is a faq" both shipped once. The phrase map
  // exists because of them, and this is what keeps it honest.
  const strings = [
    sectionInsight({ section: 6, company: 'acme', anatomy }),   // faq
    sectionInsight({ section: 8, company: 'acme', anatomy }),   // integrations
    sectionInsight({ section: 11, company: 'acme', anatomy }),  // cta, past the profile
  ].flatMap((o) => allStrings(o));

  for (const s of strings) {
    assert.doesNotMatch(s, /\ba (?:[aeiou]|faq\b|FAQ\b)/, `article disagrees in: ${s}`);
  }
  assert.ok(strings.some((s) => s.includes('an FAQ')), 'the FAQ phrase is actually reached');
});

test('a slot only one page reaches does not get dressed up as a ranking', () => {
  const out = sectionInsight({ section: 11, company: 'acme', anatomy });
  const mine = out.judged.find((j) => j.key === 'same_type_here');
  assert.match(mine.value, /^1 of 1 \(100%\) pages that reach position 11 have a call to action there$/);
  assert.doesNotMatch(mine.value, /most common/, 'first of one is not a rank');
});

test('an unresolvable company is a wiring fault and says so, rather than returning a shape full of zeroes', () => {
  const s = sectionInsight({ section: 1, company: 'nobody', anatomy });
  const p = pageInsight({ company: 'nobody', anatomy });
  assert.equal(s.company, null);
  assert.equal(p.company, null);
  assert.equal(s.notes[0].code, 'unknown-company');
  assert.equal(p.notes[0].code, 'unknown-company');
});

// ------------------------------------------- the rule that covers every string

/**
 * Walk everything and fail on a naked percentage.
 *
 * A percentage is allowed only when the n that produced it is in the same
 * sentence: "28% of 166", or "47 of 166 (28%)". Anything else is a number with
 * no way to check it, which is the one thing this project never publishes.
 */
/** Every string anywhere in a returned object. */
function allStrings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, found));
  else if (value && typeof value === 'object') for (const v of Object.values(value)) allStrings(v, found);
  return found;
}

function nakedPercentages(value, path = '$', found = []) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/(\d[\d,]*(?:\.\d+)?)%/g)) {
      const before = value.slice(Math.max(0, m.index - 80), m.index);
      const after = value.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const followedByN = /^\W{0,3}of\s+\d[\d,]*/.test(after);
      const precededByN = /\d[\d,]*\s+of\s+\d[\d,]*[^.]{0,60}$/.test(before);
      if (!followedByN && !precededByN) found.push(`${path}: ${m[0]} in "${value}"`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nakedPercentages(v, `${path}[${i}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nakedPercentages(v, `${path}.${k}`, found);
  }
  return found;
}

test('the percentage rule holds over every string either function returns', () => {
  // The detector has to be able to fail, or the test below proves nothing.
  assert.deepEqual(nakedPercentages('Conversions rose 28% last quarter').length, 1);
  assert.deepEqual(nakedPercentages('28% of 166 companies'), []);
  assert.deepEqual(nakedPercentages('47 of 166 readable pages (28%)'), []);

  const outputs = [
    pageInsight({ company: acme, anatomy }),
    pageInsight({ company: dark, anatomy }),
    pageInsight({ company: 'c01', anatomy }),
    pageInsight({ company: 'nobody', anatomy }),
    sectionInsight({ section: 1, company: acme, anatomy }),
    sectionInsight({ section: 2, company: acme, anatomy }),
    sectionInsight({ section: 11, company: acme, anatomy }),
    sectionInsight({ section: 99, company: acme, anatomy }),
    sectionInsight({ section: 2, company: dark, anatomy }),
    sectionInsight({ section: 3, company: 'c07', anatomy }),
  ];

  const bad = outputs.flatMap((o, i) => nakedPercentages(o, `out[${i}]`));
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('the whole return value is JSON, so the renderer cannot be handed a function or a Map', () => {
  const out = [pageInsight({ company: acme, anatomy }), sectionInsight({ section: 4, company: acme, anatomy })];
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('a position the page does not reach is absent, not empty', () => {
  const out = sectionInsight({ section: 99, company: 'acme', anatomy });
  assert.equal(out.readable, true);
  assert.equal(out.present, false);
  assert.match(out.notes[0].text, /runs 11 sections, so there is nothing at position 99/);
});

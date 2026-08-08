/**
 * Anatomy extraction.
 *
 * The classifier is an opinion about spans of markup, so these tests pin the
 * opinion rather than prove it correct. Correctness needs a hand-labelled
 * validation set against real pages; until that exists the honest claim is
 * "this is what the classifier does", and these cases are what it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, extractAnatomy, sectionSpans, SECTION_TYPES } from '../src/extract/anatomy.js';

const page = (inner, { nav = '', footer = '' } = {}) =>
  `<html><body>${nav}<main>${inner}</main>${footer}</body></html>`;

const lorem = (n) => Array(n).fill('word').join(' ');

test('a section is the span from one h2 to the next, and the hero is what precedes the first', () => {
  const { spans } = sectionSpans(page(`
    <h1>Headline</h1><p>${lorem(20)}</p>
    <h2>Second</h2><p>${lorem(20)}</p>
    <h2>Third</h2><p>${lorem(20)}</p>
  `));
  assert.equal(spans.length, 3);
  assert.equal(spans[0].heading, null, 'the hero has no heading of its own');
  assert.equal(spans[1].heading, 'Second');
  assert.equal(spans[2].heading, 'Third');
});

test('nav and footer are chrome and are not sections', () => {
  const out = extractAnatomy(
    page(`<h1>H</h1><p>${lorem(20)}</p><h2>Real</h2><p>${lorem(20)}</p>`, {
      nav: '<nav><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></nav>',
      footer: `<footer><h2>Footer heading</h2>${Array(9).fill('<a href="/x">x</a>').join('')}</footer>`,
    }),
    page(`<h1>H</h1>`, {
      nav: '<nav><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></nav>',
      footer: `<footer><h2>Footer heading</h2>${Array(9).fill('<a href="/x">x</a>').join('')}</footer>`,
    })
  );
  assert.equal(out.anatomy_section_count.value, '2', 'the footer h2 is not a third section');
  assert.equal(out.anatomy_nav_links.value, '3');
  assert.equal(out.anatomy_footer_links.value, '9');
});

test('classify covers its own vocabulary and returns nothing outside it', () => {
  const base = {
    isFirst: false, plain: '', words: 50, imgs: 0, links: 0, h3: 0, inputs: 0,
    table: false, details: false, quote: false, media: false,
    currency: false, quantified: false, action: false, integration: false, testimony: false,
  };
  const cases = [
    [{ ...base, isFirst: true }, null, 'hero'],
    [{ ...base, words: 4, imgs: 8 }, null, 'logos'],
    [{ ...base, details: true }, null, 'faq'],
    [{ ...base }, 'How does billing work?', 'faq'],
    [{ ...base, table: true, currency: true }, null, 'pricing'],
    [{ ...base, table: true }, null, 'comparison'],
    [{ ...base, quote: true }, null, 'testimonial'],
    [{ ...base, quantified: true, words: 40 }, null, 'proof'],
    [{ ...base, integration: true, imgs: 6, plain: 'integrations', words: 30 }, null, 'integrations'],
    [{ ...base, inputs: 3 }, null, 'cta'],
    [{ ...base, action: true, words: 20 }, null, 'cta'],
    [{ ...base, media: true, words: 10 }, null, 'media'],
    [{ ...base, h3: 4 }, null, 'features'],
    [{ ...base }, null, 'other'],
  ];
  for (const [m, heading, expected] of cases) {
    const got = classify(m, heading);
    assert.equal(got, expected, `${expected} case returned ${got}`);
    assert.ok(SECTION_TYPES.includes(got), `${got} is outside the published vocabulary`);
  }
});

test('a run of identical adjacent sections collapses, because eleven h2s is a markup habit', () => {
  const feature = (i) => `<h2>Feature ${i}</h2><h3>a</h3><h3>b</h3><p>${lorem(20)}</p>`;
  const out = extractAnatomy(
    page(`<h1>H</h1><p>${lorem(20)}</p>${[1, 2, 3, 4].map(feature).join('')}`),
    '<html></html>'
  );
  assert.equal(out.anatomy_sections.value, 'hero > features');
  assert.equal(out.anatomy_sections.json.sections.at(-1).merged, 4, 'the run reports how many it absorbed');
});

test('a heading with nothing under it is a label, not a section', () => {
  const out = extractAnatomy(
    page(`<h1>H</h1><p>${lorem(20)}</p><h2>Bare</h2><h2>Real</h2><p>${lorem(30)}</p>`),
    '<html></html>'
  );
  assert.equal(out.anatomy_section_count.value, '2');
});

test('a page whose bands are not h2-headed yields null, not a one-section answer', () => {
  // The known failure mode: div-soup with styled headings. A single section over
  // a page with real content is a parser fault, and the whole point of this
  // project is that a parser fault is never reported as a finding.
  const out = extractAnatomy(page(`<h1>H</h1><p>${lorem(400)}</p>`), '<html></html>');
  assert.equal(out.anatomy_sections, null);
  assert.equal(out.anatomy_section_count, null);
  assert.equal(out.anatomy_elements, null);
  assert.ok(out.anatomy_word_count.value > 300, 'the word count still reads, because it is not in doubt');
});

test('a genuinely short page is allowed to have one section', () => {
  const out = extractAnatomy(page(`<h1>H</h1><p>${lorem(30)}</p>`), '<html></html>');
  assert.equal(out.anatomy_section_count.value, '1', 'under the 300-word floor this is a real answer');
});

test('elements present is derived from the sequence, so the two can never disagree', () => {
  const out = extractAnatomy(
    page(`
      <h1>H</h1><p>${lorem(20)}</p>
      <h2>Loved</h2><blockquote>great</blockquote><p>${lorem(20)}</p>
      <h2>FAQ</h2><details><summary>q</summary><p>${lorem(20)}</p></details>
    `),
    '<html></html>'
  );
  const seq = out.anatomy_sections.value.split(' > ');
  const present = out.anatomy_elements.json.present;
  assert.equal(present.testimonial, seq.includes('testimonial'));
  assert.equal(present.faq, seq.includes('faq'));
  assert.equal(present.comparison, false);
});

test('the section list carries position, heading and length so a reader can check it', () => {
  const out = extractAnatomy(
    page(`<h1>H</h1><p>${lorem(20)}</p><h2>Why us</h2><p>${lorem(40)}</p>`),
    '<html></html>'
  );
  const [hero, second] = out.anatomy_sections.json.sections;
  assert.equal(hero.position, 1);
  assert.equal(hero.type, 'hero');
  assert.equal(hero.heading, null);
  assert.equal(second.position, 2);
  assert.equal(second.heading, 'Why us');
  assert.ok(second.words >= 40);
});

test('no nav and no footer are null rather than zero', () => {
  const out = extractAnatomy(page(`<h1>H</h1><p>${lorem(20)}</p><h2>B</h2><p>${lorem(20)}</p>`), '<html></html>');
  assert.equal(out.anatomy_nav_links, null, 'we did not find a nav; that is not a nav with no links');
  assert.equal(out.anatomy_footer_links, null);
});

// --------------------------------------------------------------- family gates

import { gatePage, STRUCTURE_YIELD_RATIO } from '../src/diff.js';

const gate = (familyYields) => gatePage({
  fetchOk: true,
  extraction: { signals: {}, extractable: true, variant: 'html', extractorVersion: '1.1.0', lang: 'en', canonical: null },
  previous: { variant: 'html', extractorVersion: '1.1.0', lang: 'en', canonical: null },
  currentYield: 10, previousYield: 15,
  familyYields,
});

test('a family that collapses is named, and only that family', () => {
  const g = gate({
    hero:    { previous: 5, current: 1 },
    anatomy: { previous: 8, current: 8 },
    proof:   { previous: 2, current: 2 },
  });
  assert.equal(g.diffable, false);
  assert.equal(g.status, 'changed-structure');
  assert.deepEqual(g.collapsedFamilies, ['hero']);
  assert.match(g.reason, /hero 5 -> 1/);
  assert.doesNotMatch(g.reason, /anatomy/, 'a healthy family is not blamed for a broken one');
});

test('the page-wide ratio would have missed it, which is why the gate is per family', () => {
  // 15 -> 9 page-wide is 60%, comfortably above the ratio. Hero is 5 -> 0.
  const pageWide = 9 / 15;
  assert.ok(pageWide > STRUCTURE_YIELD_RATIO, 'the old test would have stayed silent here');
  const g = gate({
    hero:    { previous: 5, current: 0 },
    anatomy: { previous: 8, current: 8 },
    proof:   { previous: 2, current: 1 },
  });
  assert.equal(g.status, 'changed-structure', 'the per-family gate catches the total hero collapse');
});

test('a family too small to judge does not trip the gate', () => {
  // proof is two signals. Losing one is 50%, which is not evidence of a
  // redesign, and the previous >= 3 floor is what stops it being read as one.
  const g = gate({
    hero:    { previous: 5, current: 5 },
    anatomy: { previous: 8, current: 8 },
    proof:   { previous: 2, current: 0 },
  });
  assert.equal(g.diffable, true, 'two signals is too few to distinguish a redesign from a bad day');
});

test('with no per-family yields supplied, the gate falls back to the page-wide rule', () => {
  const g = gatePage({
    fetchOk: true,
    extraction: { signals: {}, extractable: true, variant: 'html', extractorVersion: '1.1.0', lang: 'en', canonical: null },
    previous: { variant: 'html', extractorVersion: '1.1.0', lang: 'en', canonical: null },
    currentYield: 2, previousYield: 10,
  });
  assert.equal(g.status, 'changed-structure', 'older replays still get the original behaviour');
});

// ------------------------------------------- re-parsing after a version bump

import { applyResult } from '../src/store/files.js';

test('the ledger carries which extractor last read a page, and a 304 does not erase it', () => {
  const q = new Map();
  applyResult(q, { slug: 'acme', kind: 'home', at: 'T1', status: 'ok', extractor_version: '1.0.0', etag: 'W/"a"' });
  assert.equal(q.get('acme/home').extractor_version, '1.0.0');

  // A run that returned 304 parsed nothing, so it did not change which
  // extractor last read the page. Dropping the version here would make the
  // bypass fire forever.
  applyResult(q, { slug: 'acme', kind: 'home', at: 'T2', status: 'unchanged' });
  assert.equal(q.get('acme/home').extractor_version, '1.0.0', 'carried forward across a 304');

  applyResult(q, { slug: 'acme', kind: 'home', at: 'T3', status: 'ok', extractor_version: '1.1.0' });
  assert.equal(q.get('acme/home').extractor_version, '1.1.0');
});

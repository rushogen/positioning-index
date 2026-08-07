/**
 * Extraction tests: HTML primitives, hero signals, social proof.
 *
 * The fixtures here are deliberately built out of markup patterns observed on
 * real pages in seed/companies.json -- responsive duplicated headings wrapped
 * in aria-hidden, inline-SVG logo walls, hero copy split across animation
 * spans -- because those are what actually break naive selectors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attr, collapse, decodeEntities, dedupeRepeats, elements, headingText, jsonLd,
  meta, removeAriaHidden, stripCode, stripNonContent, stripSvg, text,
} from '../src/extract/html.js';
import {
  categoryFromText, extractCategory, extractHeadline, extractMetaDescription,
  extractMetaTitle, extractSubhead, isHidden,
} from '../src/extract/hero.js';
import { extractLogos, extractProofPoints } from '../src/extract/proof.js';
import { classifyBody, extract, signalsFor, yieldOf } from '../src/extract/index.js';
import { fnv1a } from '../src/hash.js';

const page = (body, head = '') => `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

test('decodes the entities that appear in marketing copy', () => {
  assert.equal(decodeEntities('AT&amp;T &mdash; the world&rsquo;s best'), 'AT&T — the world’s best');
  assert.equal(decodeEntities('&#8212;&#x2014;'), '——');
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
  assert.equal(decodeEntities('100&nbsp;teams'), '100 teams');
});

test('attr handles double, single and unquoted values', () => {
  assert.equal(attr('<img src="a.png">', 'src'), 'a.png');
  assert.equal(attr("<img src='a.png'>", 'src'), 'a.png');
  assert.equal(attr('<img src=a.png>', 'src'), 'a.png');
  assert.equal(attr('<img alt="Shopify&#39;s logo">', 'alt'), "Shopify's logo");
  assert.equal(attr('<img src="a.png">', 'alt'), null);
});

test('stripCode keeps inline SVG, stripSvg removes it', () => {
  const html = '<p>keep</p><script>var x = "<p>gone</p>";</script><svg><title>Shopify</title></svg><style>p{}</style><!-- c -->';
  const coded = stripCode(html);
  assert.ok(coded.includes('Shopify'), 'logo walls live in inline SVG, so stripCode must keep it');
  assert.ok(!coded.includes('var x'));
  assert.ok(!stripSvg(coded).includes('Shopify'));
  assert.ok(!stripNonContent(html).includes('Shopify'));
});

test('elements survives an unclosed tag without running to end of document', () => {
  const html = '<h1>first' + 'x'.repeat(100_000);
  const found = [...elements(html, 'h1', { maxInner: 5000 })];
  assert.equal(found.length, 1);
  assert.ok(found[0].inner.length <= 2000, 'bounded slice, not the whole document');
});

test('elements does not rescan the document per element', () => {
  const html = '<p>a</p>'.repeat(300) + 'z'.repeat(500_000);
  const started = Date.now();
  const found = [...elements(html, 'p', { limit: 400 })];
  assert.equal(found.length, 300);
  assert.ok(Date.now() - started < 250, 'must stay linear in document length');
});

test('meta reads name, property and itemprop', () => {
  const html = '<meta name="description" content="a"><meta property="og:title" content="b"><meta itemprop="x" content="c">';
  assert.equal(meta(html, 'description'), 'a');
  assert.equal(meta(html, 'OG:TITLE'), 'b');
  assert.equal(meta(html, 'x'), 'c');
  assert.equal(meta(html, 'missing'), null);
});

test('jsonLd unwraps @graph, spreads arrays and skips malformed blocks', () => {
  const html = `
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"A"}]}</script>
    <script type="application/ld+json">[{"@type":"Product","name":"B"}]</script>
    <script type="application/ld+json">{ this is not json }</script>`;
  const nodes = jsonLd(html);
  assert.deepEqual(nodes.map((n) => n.name), ['A', 'B']);
});

test('fnv1a is stable and distinguishes near-identical strings', () => {
  assert.equal(fnv1a('hello'), fnv1a('hello'));
  assert.notEqual(fnv1a('hello'), fnv1a('hellp'));
  assert.match(fnv1a('x'), /^[0-9a-f]{8}$/);
  assert.equal(fnv1a(null), null);
});

// ---------------------------------------------------------------------------
// aria-hidden and repeated headings -- the Linear case
// ---------------------------------------------------------------------------

// Structure copied from the live linear.app <h1>: three responsive duplicates
// wrapped in aria-hidden, plus one canonical visually-hidden copy.
const LINEAR_H1 = `<h1 class="sc-KOGVz title">
  <span aria-hidden="true">
    <span class="show-mobile">The product</span><span class="show-mobile"> </span>
    <span class="show-mobile">development</span><span class="show-mobile"> </span>
    <span class="show-mobile">system for teams and agents</span>
    <span class="hide-mobile">The product development</span><br class="hide-mobile"/>
    <span class="hide-mobile">system for teams and agents</span>
  </span>
  <span class="Fzcv4W_visuallyHidden">The product development system for teams and agents</span>
</h1>`;

test('aria-hidden duplicates are dropped, leaving the canonical heading', () => {
  const naive = text(LINEAR_H1.replace(/<\/?h1[^>]*>/g, ''));
  assert.ok(naive.split('The product development').length > 2, 'fixture must actually contain duplicates');

  const el = [...elements(LINEAR_H1, 'h1')][0];
  assert.equal(headingText(el.inner), 'The product development system for teams and agents');
});

test('removeAriaHidden leaves markup without aria-hidden untouched', () => {
  const frag = '<span>Plain heading</span>';
  assert.equal(removeAriaHidden(frag), frag);
});

test('dedupeRepeats collapses a phrase repeated by responsive markup', () => {
  const one = 'The system for product development';
  assert.equal(dedupeRepeats(`${one} ${one} ${one}`), one);
  assert.equal(dedupeRepeats(`${one} ${one} ${one.slice(0, 12)}`), one, 'tolerates a truncated final repeat');
  assert.equal(dedupeRepeats('Two different sentences entirely here'), 'Two different sentences entirely here');
  assert.equal(dedupeRepeats('short'), 'short');
});

test('an all-aria-hidden heading with no canonical copy still yields nothing rather than duplicates', () => {
  const h = '<h1><span aria-hidden="true">Ghost text</span></h1>';
  const el = [...elements(h, 'h1')][0];
  assert.equal(headingText(el.inner), '');
});

// ---------------------------------------------------------------------------
// headline
// ---------------------------------------------------------------------------

test('picks the first visible h1', () => {
  const doc = page('<h1>The system for product development</h1>');
  const h = extractHeadline(doc, { brand: 'Linear' });
  assert.equal(h.value, 'The system for product development');
  assert.equal(h.method, 'h1');
  assert.equal(h.confidence, 1.0);
});

test('skips a screen-reader-only h1 in favour of the visible one', () => {
  const doc = page('<h1 class="sr-only">Linear</h1><h1>The system for product development</h1>');
  assert.equal(extractHeadline(doc, { brand: 'Linear' }).value, 'The system for product development');
});

test('isHidden recognises the common hiding idioms', () => {
  assert.equal(isHidden('<h1 class="sr-only">'), true);
  assert.equal(isHidden('<h1 class="a visually-hidden b">'), true);
  assert.equal(isHidden('<h1 class="Fzcv4W_visuallyHidden">'), true);
  assert.equal(isHidden('<h1 style="display:none">'), true);
  assert.equal(isHidden('<h1 aria-hidden="true">'), true);
  assert.equal(isHidden('<h1 class="hero-title">'), false);
});

test('rejects a bare brand name and nav junk as a headline', () => {
  assert.equal(extractHeadline(page('<h1>Linear</h1>'), { brand: 'Linear' }), null);
  assert.equal(extractHeadline(page('<h1>Skip to main content</h1>')), null);
  assert.equal(extractHeadline(page('<h1>Hi</h1>')), null, 'too short to be a claim');
});

test('falls back to og:title with reduced confidence and says so', () => {
  const doc = page('<div>no heading here</div>', '<meta property="og:title" content="The AI workspace that works for you">');
  const h = extractHeadline(doc, { brand: 'Notion' });
  assert.equal(h.method, 'og:title-fallback');
  assert.ok(h.confidence < 0.5, 'a fallback must be scored low so the diff engine can distrust it');
});

test('reads a hero rendered as a div with role=heading', () => {
  const doc = page('<div role="heading" aria-level="1">Agentic infrastructure for the web</div>');
  const h = extractHeadline(doc);
  assert.equal(h.value, 'Agentic infrastructure for the web');
  assert.equal(h.method, 'aria-heading');
});

// ---------------------------------------------------------------------------
// subhead
// ---------------------------------------------------------------------------

test('takes the paragraph following the headline', () => {
  const doc = page('<h1>Plan and build products</h1><p>Purpose-built for modern software teams.</p>');
  const h = extractHeadline(doc);
  const s = extractSubhead(doc, h);
  assert.equal(s.value, 'Purpose-built for modern software teams.');
  assert.equal(s.method, 'p-after-h1');
});

test('skips cookie and legal boilerplate sitting next to the hero', () => {
  const doc = page('<h1>Plan and build products</h1><p>By clicking accept you agree to our cookie policy.</p><p>Purpose-built for modern software teams.</p>');
  assert.equal(extractSubhead(doc, extractHeadline(doc)).value, 'Purpose-built for modern software teams.');
});

// ---------------------------------------------------------------------------
// category label
// ---------------------------------------------------------------------------

test('pulls modifiers, noun and object out of a positioning line', () => {
  const c = categoryFromText('The product development system for teams and agents');
  assert.equal(c.noun, 'system');
  assert.deepEqual(c.modifiers, ['product', 'development']);
  assert.equal(c.phrase, 'product development system for teams and agents');
});

test('stops at an article rather than swallowing it', () => {
  assert.deepEqual(categoryFromText('The AI workspace that works for you').modifiers, ['AI']);
  assert.equal(categoryFromText('The AI workspace that works for you').phrase, 'ai workspace');
});

test('recognises multi-word categories over their substrings', () => {
  assert.equal(categoryFromText('The system of record for revenue').noun, 'system of record');
  assert.equal(categoryFromText('The customer data platform for growth teams').noun, 'customer data platform');
});

test('a bare weak noun in a sentence is not a category claim', () => {
  assert.equal(categoryFromText('Where teams and agents think together'), null);
  assert.equal(categoryFromText('Build apps faster'), null);
});

test('scores a rich phrase from the meta title above a bare noun from the h1', () => {
  const doc = page('<h1>Where teams and agents think together</h1>', '<title>The AI workspace that works for you | Notion</title>');
  const c = extractCategory(doc, doc, {
    headline: extractHeadline(doc, { brand: 'Notion' }),
    metaTitle: extractMetaTitle(doc, doc),
    metaDescription: extractMetaDescription(doc),
  });
  assert.equal(c.value, 'ai workspace');
  assert.equal(c.method, 'pattern:meta-title');
});

test("schema.org's applicationCategory vocabulary is rejected", () => {
  const ld = '<script type="application/ld+json">{"@type":"SoftwareApplication","applicationCategory":"DeveloperApplication"}</script>';
  const doc = page('<h1>Agentic infrastructure for every app</h1>', ld);
  const c = extractCategory(doc, doc, { headline: extractHeadline(doc) });
  assert.notEqual(c.value, 'developerapplication');
  // The "for X" object is part of the category claim, not decoration.
  assert.equal(c.value, 'agentic infrastructure for every app');
  assert.equal(c.method, 'pattern:h1');
});

test('a free-text applicationCategory IS used', () => {
  const ld = '<script type="application/ld+json">{"@type":"SoftwareApplication","applicationCategory":"Revenue Intelligence"}</script>';
  const doc = page('<h1>The platform for revenue teams</h1>', ld);
  const c = extractCategory(doc, doc, { headline: extractHeadline(doc) });
  assert.equal(c.value, 'revenue intelligence');
});

// ---------------------------------------------------------------------------
// customer logos
// ---------------------------------------------------------------------------

test('reads a logo wall introduced by a lead phrase', () => {
  const doc = stripCode(page(`
    <section><h2>Trusted by fast-growing teams</h2>
      <img src="/logos/shopify.svg" alt="Shopify">
      <img src="/logos/ramp-color.svg" alt="Ramp logo">
      <img src="/logos/vercel.svg" alt="">
      <svg class="logo"><title>OpenAI</title></svg>
    </section>`));
  const l = extractLogos(doc, { brand: 'Acme' });
  assert.deepEqual(l.json.names, ['OpenAI', 'Ramp', 'Shopify', 'Vercel']);
  assert.equal(l.method, 'proof-region');
  assert.ok(l.value.startsWith('OpenAI, Ramp'), 'names are sorted so reordering is not a change');
});

test('call-to-action alt text never becomes a customer name', () => {
  const doc = stripCode(page(`
    <section><h2>Trusted by teams everywhere</h2>
      <img src="/a.svg" alt="Read the story">
      <img src="/b.svg" alt="Watch the demo">
      <img src="/logos/figma.svg" alt="Figma">
      <img src="/logos/stripe.svg" alt="Stripe">
      <img src="/logos/linear.svg" alt="Linear">
    </section>`));
  const l = extractLogos(doc, {});
  assert.deepEqual(l.json.names, ['Figma', 'Linear', 'Stripe']);
});

test('decorative and generic images are excluded', () => {
  const doc = stripCode(page(`
    <section><h2>Trusted by teams</h2>
      <img src="/icons/arrow.svg" alt="arrow">
      <img src="/hero-background.png" alt="background">
      <img src="/logos/notion-white-2x.svg" alt="">
      <img src="/logos/figma.svg" alt="">
      <img src="/logos/stripe.svg" alt="">
    </section>`));
  const l = extractLogos(doc, {});
  assert.deepEqual(l.json.names, ['Figma', 'Notion', 'Stripe']);
});

test('fewer than three names is noise, not a logo wall', () => {
  const doc = stripCode(page('<section><h2>Trusted by</h2><img src="/logos/figma.svg" alt="Figma"></section>'));
  assert.equal(extractLogos(doc, {}), null);
});

test("the company's own logo is not one of its customers", () => {
  const doc = stripCode(page(`
    <section><h2>Trusted by teams</h2>
      <img src="/logos/acme.svg" alt="Acme">
      <img src="/logos/figma.svg" alt="Figma">
      <img src="/logos/stripe.svg" alt="Stripe">
      <img src="/logos/linear.svg" alt="Linear">
    </section>`));
  assert.ok(!extractLogos(doc, { brand: 'Acme' }).json.names.includes('Acme'));
});

// ---------------------------------------------------------------------------
// proof points
// ---------------------------------------------------------------------------

const proof = (s) => extractProofPoints(collapse(s));

test('extracts multipliers, percentages, counts and durations', () => {
  const p = proof('Ship 10x faster. Cut onboarding by 40%. Join 20,000 teams. Set up in under 5 minutes.');
  const claims = p.json.items.map((i) => i.claim);
  assert.ok(claims.some((c) => c.includes('10x faster')), claims.join(' | '));
  assert.ok(claims.some((c) => c.includes('40%')), claims.join(' | '));
  assert.ok(claims.some((c) => c.includes('20,000 teams')), claims.join(' | '));
  assert.ok(claims.some((c) => c.includes('5 minutes')), claims.join(' | '));
});

test('claims are sorted and de-duplicated so carousel order is not a change', () => {
  const a = proof('Join 20,000 teams. Ship 10x faster.');
  const b = proof('Ship 10x faster. Join 20,000 teams. Ship 10x faster.');
  assert.equal(a.value, b.value);
});

test('a bare year is not a proof point', () => {
  const p = proof('Founded 2019. Copyright 2026 Acme. All rights reserved.');
  assert.equal(p, null);
});

test('a page with no quantified claims yields null rather than an empty string', () => {
  assert.equal(proof('We make software for teams who care about their craft.'), null);
});

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

test('classifyBody refuses non-HTML variants', () => {
  assert.deepEqual(classifyBody('<!doctype html><html></html>', 'text/html'), { variant: 'html', extractable: true });
  assert.equal(classifyBody('# Ramp — Machine Version\n\nstuff', 'text/markdown').variant, 'agent-markdown');
  assert.equal(classifyBody('# Ramp — Machine Version\n\nstuff', '').variant, 'agent-markdown');
  assert.equal(classifyBody('{"a":1}', 'application/json').extractable, false);
  assert.equal(classifyBody('not html at all', 'text/html').variant, 'not-html');
});

test('extract returns every declared signal, null where nothing was found', () => {
  const out = extract('home', page('<h1>The system for product development</h1>'), 'https://example.com/');
  assert.deepEqual(Object.keys(out.signals).sort(), signalsFor('home').sort());
  assert.equal(out.lang, 'en');
  assert.equal(out.variant, 'html');
  assert.ok(yieldOf(out) >= 2);
  assert.equal(out.signals.customer_logos, null, 'absent signals are null, never fabricated');
});

test('extract never throws on hostile or empty input', () => {
  for (const body of ['', '<html>', '<h1>'.repeat(5000), '<<<>>>', null, 'x'.repeat(200_000)]) {
    assert.doesNotThrow(() => extract('home', body, 'https://example.com/'));
    assert.doesNotThrow(() => extract('pricing', body, 'https://example.com/'));
  }
});

test('a non-extractable variant yields all-null signals, not garbage', () => {
  const out = extract('home', '# Ramp — Machine Version\n\nRamp is an all-in-one spend platform', 'https://ramp.com/', { contentType: 'text/markdown' });
  assert.equal(out.extractable, false);
  assert.equal(out.variant, 'agent-markdown');
  assert.equal(yieldOf(out), 0);
});

test('the internal headline offset does not leak into the stored signal', () => {
  const out = extract('home', page('<h1>The system for product development</h1><p>Built for teams.</p>'), 'https://example.com/');
  assert.equal(out.signals.headline.index, undefined);
});

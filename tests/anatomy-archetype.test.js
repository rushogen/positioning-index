import test from 'node:test';
import assert from 'node:assert/strict';
import { archetype } from '../src/anatomy-archetype.js';

const page = (slug, ...types) => ({
  slug, name: slug.toUpperCase(),
  sections: types.map((t, i) => ({ position: i + 1, type: t, heading: `${t} on ${slug}`, words: 40 })),
});

test('bands are ordered by typical position, hero pinned first', () => {
  const a = archetype({ companies: [
    page('a', 'hero', 'features', 'proof', 'cta'),
    page('b', 'hero', 'features', 'testimonial', 'cta'),
    page('c', 'hero', 'proof', 'features', 'cta'),
  ]}, { floor: 0 });
  const order = a.bands.map((b) => b.type);
  assert.equal(order[0], 'hero', 'hero is always first');
  assert.equal(order.at(-1), 'cta', 'cta appears last on every page, so it sorts last');
  assert.ok(order.indexOf('features') < order.indexOf('cta'));
});

test('every band states its absence as well as its presence', () => {
  const a = archetype({ companies: [
    page('a', 'hero', 'logos'),
    page('b', 'hero'),
    page('c', 'hero', 'logos'),
    page('d', 'hero'),
  ]}, { floor: 0 });
  const logos = a.bands.find((b) => b.type === 'logos');
  assert.equal(logos.carriers, 2);
  assert.equal(logos.absent, 2, 'half the pages do not carry it, and that is on the band');
  assert.equal(logos.share, 0.5);
  assert.equal(logos.of, 4);
});

test('a type is counted once per page even if it repeats, at its first position', () => {
  const a = archetype({ companies: [
    { slug: 'x', name: 'X', sections: [
      { position: 1, type: 'hero', heading: 'h', words: 10 },
      { position: 2, type: 'features', heading: 'f1', words: 10 },
      { position: 5, type: 'features', heading: 'f2', words: 10 },
    ] },
  ]}, { floor: 0 });
  const feat = a.bands.find((b) => b.type === 'features');
  assert.equal(feat.carriers, 1, 'one page carries features, not two');
  assert.equal(feat.median_position, 2, 'measured at its first occurrence');
});

test('other is never a band, but its reach is reported', () => {
  const a = archetype({ companies: [
    page('a', 'hero', 'other', 'cta'),
    page('b', 'hero', 'cta'),
  ]}, { floor: 0 });
  assert.ok(!a.bands.some((b) => b.type === 'other'), 'other is not a section a page publishes');
  assert.equal(a.unclassified.pages_with_any, 1);
});

test('below-floor types are withheld from the diagram but listed, not dropped', () => {
  const companies = [];
  for (let i = 0; i < 20; i++) companies.push(page(`c${i}`, 'hero', 'features'));
  companies[0].sections.push({ position: 3, type: 'faq', heading: 'q?', words: 20 }); // 1/20 = 5%
  const a = archetype({ companies }, { floor: 0.15 });
  assert.ok(!a.bands.some((b) => b.type === 'faq'), 'a 5% type is not drawn');
  assert.ok(a.below_floor.some((b) => b.type === 'faq'), 'but it is listed with its count');
});

test('unreadable pages are excluded from the denominator', () => {
  const a = archetype({ companies: [
    page('a', 'hero', 'features'),
    { slug: 'b', name: 'B', sections: null },
  ]}, { floor: 0 });
  assert.equal(a.readable_pages, 1);
  assert.equal(a.of_total, 2);
  assert.equal(a.bands.find((b) => b.type === 'hero').of, 1);
});

test('deterministic: same corpus, same bytes', () => {
  const c = [page('a', 'hero', 'proof'), page('b', 'hero', 'features')];
  assert.deepEqual(archetype({ companies: c }), archetype({ companies: c }));
});

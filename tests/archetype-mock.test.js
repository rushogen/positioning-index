import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArchetypeMock } from '../src/archetype-mock.js';

const page = (slug, ...types) => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1),
  sections: types.map((t, i) => ({ position: i + 1, type: t, heading: `${t} on ${slug}`, words: 40 })),
});
const anatomy = () => ({ companies: [
  page('linear', 'hero', 'features', 'proof', 'cta'),
  page('notion', 'hero', 'features', 'testimonial'),
  page('stripe', 'hero', 'pricing', 'proof', 'cta'),
  page('okta', 'hero', 'logos', 'proof'),
]});

test('renders a block and a matching insight card per band', () => {
  const html = renderArchetypeMock(anatomy());
  // every mk-sec block has a mk-insight target with the same id
  const blocks = [...html.matchAll(/href="#mk-i-([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(blocks.includes('hero') && blocks.includes('features'));
  for (const t of blocks) assert.ok(html.includes(`id="mk-i-${t}"`), `insight card for ${t}`);
});

test('every share is stated with its denominator, never bare', () => {
  const html = renderArchetypeMock(anatomy());
  // each headline reads "N% of M pages carry it"
  assert.ok(/\d+%<\/b> of \d+ pages carry it/.test(html));
});

test('a majority section names who omits it; a minority names who does it', () => {
  const html = renderArchetypeMock(anatomy());
  // features is 50% (2 of 4) -> names the 2 that omit it; logos is 25% -> names
  // the 1 that ships it. A 100% section (hero) correctly shows no breakers.
  assert.match(html, /Ships without it \(2 of 4\)/);
  assert.match(html, /Among the 1 that use it/);
});

test('output is deterministic and escapes headings', () => {
  const a = { companies: [page('x', 'hero'), { slug: 'y', name: 'Y', sections: [{ position: 1, type: 'hero', heading: '<script>', words: 5 }] }] };
  assert.equal(renderArchetypeMock(a), renderArchetypeMock(a));
  assert.ok(!renderArchetypeMock(a).includes('<script>'));
});

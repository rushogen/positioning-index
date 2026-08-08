/**
 * The page wireframe.
 *
 * This is a drawing, so most of what could be tested about it is a matter of
 * taste and belongs in a browser. What is pinned here is the part that is not:
 * the output is a string that lands in docs/index.html unaltered, so it has to
 * be byte-stable, it has to be escaped, it has to survive the shape of the real
 * data (a hero with no heading, a page with no readable sections, a 1,887-word
 * band), and it has to carry the accessible name on every block rather than
 * leaving the meaning in the colour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BLOCK_HEIGHT,
  MIN_BLOCK_HEIGHT,
  SECTION_LABEL,
  blockHeight,
  renderWireframe,
  sectionLabel,
} from '../src/anatomy-svg.js';
import { SECTION_TYPES } from '../src/extract/anatomy.js';

/** The shape docs/api/anatomy.json actually publishes, trimmed to one company. */
const linear = {
  slug: 'linear',
  name: 'Linear',
  maxWords: 1887,
  sections: [
    { position: 1, type: 'hero', heading: null, words: 207 },
    { position: 2, type: 'features', heading: 'A new species of product tool', words: 140 },
    { position: 3, type: 'proof', heading: 'Define the product direction', words: 127 },
  ],
};

/** Every rect height in the drawing, in document order. */
const heights = (svg) => [...svg.matchAll(/<rect\b[^>]*\bheight="(\d+)"/g)].map((m) => Number(m[1]));

/** Every aria-label in the drawing, in document order. */
const ariaLabels = (svg) => [...svg.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);

test('the same input renders the same bytes', () => {
  assert.equal(renderWireframe(linear), renderWireframe(linear));
});

test('sections are drawn in position order however they arrive', () => {
  const shuffled = { ...linear, sections: [linear.sections[2], linear.sections[0], linear.sections[1]] };
  assert.equal(renderWireframe(shuffled), renderWireframe(linear));
});

test('every section type in the published vocabulary has a human label', () => {
  const missing = [...SECTION_TYPES].sort().filter((type) => !Object.hasOwn(SECTION_LABEL, type));
  assert.deepEqual(missing, [], 'add these to SECTION_LABEL in src/anatomy-svg.js');
});

test('an unrecognised type falls back to its key rather than to undefined', () => {
  assert.equal(sectionLabel('newly-invented'), 'newly-invented');
  assert.equal(sectionLabel(undefined), 'other');
});

test('a long unrecognised type is truncated in the drawing but never in the aria-label', () => {
  const type = 'a-very-long-classifier-type-key-that-would-run-off-the-edge';
  const svg = renderWireframe({
    slug: 'x', name: 'X', maxWords: 100,
    sections: [{ position: 1, type, heading: null, words: 50 }],
  });
  assert.match(svg, /&hellip;<\/text>/, 'the visible label is cut short');
  assert.ok(!svg.includes(`>${type}</text>`), 'the full key is not drawn');
  assert.equal(ariaLabels(svg)[0], `Section 1 of 1: ${type}. No heading. 50 words.`);
});

test('a heading is data, never markup', () => {
  const heading = 'He said "go" & <script>alert(1)</script>';
  const svg = renderWireframe({
    slug: 'evil', name: 'Evil & Co', maxWords: 100,
    sections: [{ position: 1, type: 'hero', heading, words: 10 }],
  });

  assert.ok(!svg.includes('<script>'), 'no live script tag survives');
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(svg.includes('&quot;go&quot;'), 'the quotes cannot close the attribute');
  assert.ok(svg.includes('&amp;'), 'the ampersand is escaped');
  // The attribute is still a single well-formed attribute afterwards.
  assert.equal(ariaLabels(svg).length, 1);
});

test('the hero has no heading of its own and says so', () => {
  const svg = renderWireframe(linear);
  assert.equal(ariaLabels(svg)[0], 'Section 1 of 3: Hero. No heading. 207 words.');
  assert.equal(
    ariaLabels(svg)[2],
    'Section 3 of 3: Proof / numbers. Heading: &quot;Define the product direction&quot;. 127 words.'
  );
});

test('one word is one word', () => {
  const svg = renderWireframe({
    slug: 'x', name: 'X', maxWords: 100,
    sections: [{ position: 1, type: 'cta', heading: 'Go', words: 1 }],
  });
  assert.match(ariaLabels(svg)[0], /1 word\.$/);
});

test('a section shorter than the scale still gets the minimum height', () => {
  assert.equal(blockHeight(1, 1887), MIN_BLOCK_HEIGHT);
  assert.equal(blockHeight(0, 1887), MIN_BLOCK_HEIGHT);
  const svg = renderWireframe({
    slug: 'x', name: 'X', maxWords: 1887,
    sections: [{ position: 1, type: 'logos', heading: 'Trusted by', words: 4 }],
  });
  assert.deepEqual(heights(svg), [MIN_BLOCK_HEIGHT]);
});

test('a 23,000-word outlier cannot produce a 4,000-unit drawing', () => {
  assert.equal(blockHeight(23_000, 1499), MAX_BLOCK_HEIGHT);
  const svg = renderWireframe({
    slug: 'x', name: 'X', maxWords: 1499,
    sections: [{ position: 1, type: 'hero', heading: null, words: 23_000 }],
  });
  assert.deepEqual(heights(svg), [MAX_BLOCK_HEIGHT]);
  const [, viewBoxHeight] = /viewBox="0 0 320 (\d+)"/.exec(svg);
  assert.ok(Number(viewBoxHeight) < 200, `viewBox height was ${viewBoxHeight}`);
});

test('a missing or zero scale does not divide by zero', () => {
  assert.equal(blockHeight(100, 0), MIN_BLOCK_HEIGHT);
  assert.equal(blockHeight(100, undefined), MIN_BLOCK_HEIGHT);
  const svg = renderWireframe({ slug: 'x', name: 'X', maxWords: 0, sections: linear.sections });
  assert.deepEqual(heights(svg), [MIN_BLOCK_HEIGHT, MIN_BLOCK_HEIGHT, MIN_BLOCK_HEIGHT]);
});

test('the viewBox is exactly the sum of the blocks, the gaps and the padding', () => {
  const svg = renderWireframe(linear);
  const [, viewBoxHeight] = /viewBox="0 0 320 (\d+)"/.exec(svg);
  const blocks = heights(svg);
  const expected = 10 * 2 + blocks.reduce((a, b) => a + b, 0) + 3 * (blocks.length - 1);
  assert.equal(Number(viewBoxHeight), expected);
});

test('no readable sections renders an empty drawing rather than throwing', () => {
  for (const sections of [[], null, undefined]) {
    const svg = renderWireframe({ slug: 'pega', name: 'Pega', maxWords: 1887, sections });
    assert.match(svg, /^<svg /);
    assert.match(svg, /<title id="wf-title-pega">Pega: no readable section sequence\.<\/title>/);
    assert.ok(!svg.includes('<g '), 'there is nothing to make focusable');
    assert.match(svg, /No readable sections/);
  }
});

test('the drawing is fluid: a viewBox and no pixel width', () => {
  const svg = renderWireframe(linear);
  assert.match(svg, /viewBox="0 0 320 \d+"/);
  assert.match(svg, /width="100%"/);
  assert.match(svg, /height="auto"/);
  assert.ok(!/\bwidth="\d+(px)?"/.test(svg.slice(0, svg.indexOf('>'))), 'the svg itself has no pixel width');
});

test('the title is the accessible name and its id is unique per company', () => {
  const svg = renderWireframe(linear);
  assert.match(svg, /^<svg class="wf" viewBox="0 0 320 \d+" width="100%" height="auto" role="group" aria-labelledby="wf-title-linear">/);
  assert.match(svg, /^<svg[^>]*><title id="wf-title-linear">/, 'the title is the first child');
});

test('every block is focusable, in order, and names its own type', () => {
  const svg = renderWireframe(linear);
  const groups = [...svg.matchAll(/<g class="wf-sec"[^>]*>/g)].map((m) => m[0]);
  assert.equal(groups.length, 3);

  groups.forEach((g, i) => {
    const section = linear.sections[i];
    assert.ok(g.includes('tabindex="0"'), 'reachable by keyboard');
    assert.ok(g.includes('role="button"'), 'announced as interactive');
    assert.ok(g.includes(`data-section="${section.position}"`));
    assert.ok(g.includes(`data-type="${section.type}"`));
    // Never colour alone: the type is in the accessible name of every block.
    assert.ok(g.includes(escapeAttr(SECTION_LABEL[section.type])), 'the type name is in the aria-label');
  });
});

test('colour is a class and nothing else', () => {
  const svg = renderWireframe(linear);
  assert.ok(!/\bfill=/.test(svg), 'no fill attribute');
  assert.ok(!/\bstroke=/.test(svg), 'no stroke attribute');
  assert.ok(!/\bstyle=/.test(svg), 'no inline style');
  assert.match(svg, /class="wf-block wf-t-hero"/);
  assert.match(svg, /class="wf-block wf-t-features"/);
  assert.match(svg, /class="wf-block wf-t-proof"/);
});

test('every type in the vocabulary renders without special-casing', () => {
  const svg = renderWireframe({
    slug: 'all', name: 'All',
    maxWords: 500,
    sections: [...SECTION_TYPES].sort().map((type, i) => ({
      position: i + 1, type, heading: `Heading ${i + 1}`, words: 100 + i,
    })),
  });
  for (const type of SECTION_TYPES) {
    assert.ok(svg.includes(`data-type="${type}"`), `${type} is missing from the drawing`);
    assert.ok(svg.includes(`wf-t-${type}`), `${type} has no colour class`);
  }
  assert.equal(ariaLabels(svg).length, SECTION_TYPES.length);
});

/** The same escaping charts.js applies, spelled out so the expectation is visible. */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

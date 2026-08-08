import test from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, sequenceDistance, neighbourGraph } from '../src/anatomy-similarity.js';

test('edit distance counts insertions, deletions and substitutions', () => {
  assert.equal(editDistance(['a', 'b', 'c'], ['a', 'b', 'c']), 0);
  assert.equal(editDistance(['a', 'b', 'c'], ['a', 'c']), 1);
  assert.equal(editDistance(['a'], ['b']), 1);
  assert.equal(editDistance([], ['a', 'b']), 2);
});

test('order matters, which is why this is not a set comparison', () => {
  const forward = ['hero', 'features', 'proof'];
  const reverse = ['hero', 'proof', 'features'];
  assert.ok(sequenceDistance(forward, reverse) > 0, 'the same types in a different order are not the same page');
});

test('distance is normalised by the longer sequence, so lengths are comparable', () => {
  // One deletion out of three.
  assert.equal(sequenceDistance(['a', 'b', 'c'], ['a', 'b']), 1 / 3);
  assert.equal(sequenceDistance(['a'], ['a']), 0);
});

test('an unreadable sequence is not similar to anything, including another unreadable one', () => {
  assert.equal(sequenceDistance(null, ['a']), null);
  assert.equal(sequenceDistance([], []), null, 'two gaps are not a match');
});

test('the graph is deterministic and excludes self', () => {
  const companies = [
    { slug: 'b', name: 'B', sections: [{ position: 1, type: 'hero' }, { position: 2, type: 'proof' }] },
    { slug: 'a', name: 'A', sections: [{ position: 1, type: 'hero' }, { position: 2, type: 'proof' }] },
    { slug: 'c', name: 'C', sections: [{ position: 1, type: 'hero' }, { position: 2, type: 'faq' }] },
    { slug: 'd', name: 'D', sections: null },
  ];
  const one = neighbourGraph(companies, { k: 2 });
  const two = neighbourGraph(companies, { k: 2 });
  assert.deepEqual(one, two, 'same input, same bytes');
  assert.ok(!one.neighbours.a.some((n) => n.slug === 'a'), 'a page is not its own neighbour');
  assert.equal(one.neighbours.a[0].slug, 'b');
  assert.equal(one.neighbours.a[0].distance, 0, 'identical sequences are distance 0');
  assert.equal(one.neighbours.d, undefined, 'a page with no readable sequence is not in the graph');
  assert.deepEqual(one.scope, { compared: 3, of: 4 });
});

test('sections are read in position order, not array order', () => {
  const scrambled = [
    { slug: 'x', name: 'X', sections: [{ position: 2, type: 'proof' }, { position: 1, type: 'hero' }] },
    { slug: 'y', name: 'Y', sections: [{ position: 1, type: 'hero' }, { position: 2, type: 'proof' }] },
  ];
  assert.equal(neighbourGraph(scrambled, { k: 1 }).neighbours.x[0].distance, 0);
});

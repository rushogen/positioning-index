/**
 * How alike are two pages, structurally?
 *
 * Not what they say -- hero.js reads that -- but the order they put things in.
 * "Linear is shaped like Attio and nothing like Oracle" is a claim about
 * sequence, and it is the claim a reader most wants after seeing their own page
 * drawn: who else looks like this?
 *
 * THE MEASURE
 * -----------
 * Normalised Levenshtein distance over the sequence of section types, where the
 * alphabet is the classifier's vocabulary and each section is one symbol.
 * `hero > features > proof` against `hero > proof` is one deletion out of a
 * length-3 sequence: distance 1/3.
 *
 * Edit distance rather than a set comparison, because order is the whole point.
 * Two pages carrying exactly the same six kinds of section in opposite orders
 * are not the same page, and Jaccard on the type sets would call them identical.
 *
 * Normalised by the longer sequence so a 3-section page and a 19-section page
 * can be compared at all. Without it every short page looks similar to every
 * other short page purely because there is less of it to disagree about.
 *
 * WHAT THIS INHERITS
 * ------------------
 * Everything. The sequence comes from the classifier, which is currently right
 * about 49% of non-hero sections, so a neighbour list is a judgement resting on
 * a judgement. Every consumer of this module must carry the same caveat as any
 * other type-derived claim, and `neighboursOf` returns the distance so a reader
 * can see how close "closest" actually is -- a nearest neighbour at 0.71 is not
 * a lookalike, it is the least unlike page in the corpus.
 *
 * COST
 * ----
 * O(n^2) pairs, each an edit distance over sequences of typically 5-9 symbols.
 * At 180 readable pages that is ~16k comparisons of trivial size, tens of
 * milliseconds at build time. It is computed once here and published, rather
 * than recomputed in every visitor's browser, so the neighbour list is part of
 * the record and can be argued with.
 */

/** Levenshtein distance between two arrays of symbols. */
export function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * 0 means the same sequence, 1 means nothing in common.
 *
 * Two pages with no readable sequence are not "identical"; they are both
 * unknown, and comparing them returns null so the caller cannot average a gap
 * into a similarity.
 */
export function sequenceDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return null;
  const longer = Math.max(a.length, b.length);
  return editDistance(a, b) / longer;
}

const typesOf = (company) =>
  Array.isArray(company.sections)
    ? company.sections.slice().sort((x, y) => x.position - y.position).map((s) => s.type)
    : null;

/**
 * The k closest pages to each company, with the distance that put them there.
 *
 * Ties are broken by name so the output is deterministic: the same data must
 * produce the same bytes, or every build is a spurious diff.
 */
export function neighbourGraph(companies, { k = 6 } = {}) {
  const rows = companies
    .map((c) => ({ slug: c.slug, name: c.name, segment: c.segment, seq: typesOf(c) }))
    .filter((r) => r.seq && r.seq.length)
    .sort((a, b) => a.slug.localeCompare(b.slug, 'en'));

  const neighbours = {};
  for (const a of rows) {
    const scored = [];
    for (const b of rows) {
      if (b.slug === a.slug) continue;
      const d = sequenceDistance(a.seq, b.seq);
      if (d === null) continue;
      scored.push({ slug: b.slug, distance: Math.round(d * 1000) / 1000 });
    }
    scored.sort((x, y) => x.distance - y.distance || x.slug.localeCompare(y.slug, 'en'));
    neighbours[a.slug] = scored.slice(0, k);
  }

  return {
    method:
      'Normalised Levenshtein distance over the ordered sequence of section types, '
      + 'divided by the longer sequence. 0 is an identical sequence, 1 shares nothing. '
      + 'The sequence comes from the classifier, so a neighbour list inherits its accuracy.',
    k,
    scope: { compared: rows.length, of: companies.length },
    neighbours,
  };
}

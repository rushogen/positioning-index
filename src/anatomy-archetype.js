/**
 * The archetype page: what a B2B SaaS homepage looks like when you average 180
 * of them, stated so that the averaging cannot be mistaken for a prescription.
 *
 * WHAT IT IS
 * ----------
 * For each section type, two numbers computed off the corpus:
 *   - how many readable pages carry it at all (its prevalence), and
 *   - where it first appears when it does (its typical position).
 * The types are then laid out in typical-position order. The result reads like a
 * single page -- hero, then logo wall, then features, and so on -- but it is a
 * composite, and no real page is required to match it.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not the most common sequence. Exact section sequences are nearly unique
 * across 180 pages, so "the most common sequence" has an n of two or three and
 * describes almost nothing. Position-wise assembly describes the market.
 *
 * It is not advice. This project measures what companies converged on and where
 * the outliers are; it does not tell anyone what to publish. So every band
 * carries its absence as loudly as its presence -- "35% carry a logo wall" is
 * also "65% do not" -- because the interesting page is often the one that leaves
 * a common band out, and a conformity diagram that hides the non-conformers is
 * the exact failure this repository was built to avoid.
 *
 * WHAT IT RESTS ON
 * ----------------
 * The section types come from the classifier, which is right about half the time
 * on non-hero sections. Everything derived here inherits that, and the caveat
 * travels with the output rather than sitting in a footnote.
 */

/** Median of a numeric array, or null if empty. Ties round toward the lower. */
function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build the archetype from the anatomy model.
 *
 * `hero` is always first and always present, so it anchors the diagram; it is
 * kept. `other` is excluded from the bands -- it is the classifier's "could not
 * name", not a section a page deliberately publishes -- but its share is
 * reported separately so the diagram does not quietly pretend the unnamed
 * sections are not there.
 *
 * The prevalence floor keeps a band off the diagram when too few pages carry the
 * type to say anything, rather than drawing a sliver that invites a conclusion
 * from five companies. Below-floor types are still listed, as a plain count, for
 * the same reason the suppressed segment cuts are listed rather than dropped.
 */
export function archetype({ companies }, { floor = 0.15 } = {}) {
  const readable = companies.filter((c) => Array.isArray(c.sections) && c.sections.length);
  const of = readable.length;

  // First-occurrence position and heading of each type on each page. First,
  // because "where does proof appear" means where it first shows up, not where
  // a page that repeats it happens to end.
  const byType = new Map();
  for (const c of readable) {
    const firstSeen = new Map();
    for (const s of c.sections.slice().sort((a, b) => a.position - b.position)) {
      if (!firstSeen.has(s.type)) firstSeen.set(s.type, s);
    }
    for (const [type, sec] of firstSeen) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push({ slug: c.slug, name: c.name, position: sec.position, heading: sec.heading, words: sec.words });
    }
  }

  const carrierSlugs = new Map();
  for (const [type, hits] of byType) carrierSlugs.set(type, new Set(hits.map((h) => h.slug)));

  const rows = [];
  const belowFloor = [];
  for (const [type, hits] of byType) {
    if (type === 'other') continue;
    const share = hits.length / of;
    // Who omits a section everyone else ships -- the "who breaks it" for a
    // convention. Sampled and sorted by name, with the count that is not shown,
    // so a short list is never mistaken for the whole set.
    const absentAll = readable
      .filter((c) => !carrierSlugs.get(type).has(c.slug))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const row = {
      type,
      carriers: hits.length,
      of,
      share: Math.round(share * 1000) / 1000,
      absent: of - hits.length,
      median_position: median(hits.map((h) => h.position)),
      median_words: median(hits.map((h) => h.words ?? 0)),
      examples: hits
        .filter((h) => h.heading)
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .slice(0, 12)
        .map((h) => ({ slug: h.slug, name: h.name, heading: h.heading })),
      examples_of: hits.filter((h) => h.heading).length,
      carrier_examples: hits.slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .slice(0, 10)
        .map((h) => ({ slug: h.slug, name: h.name })),
      absent_examples: absentAll.slice(0, 10).map((c) => ({ slug: c.slug, name: c.name })),
      absent_omitted: Math.max(0, absentAll.length - 10),
    };
    if (type !== 'hero' && share < floor) belowFloor.push(row);
    else rows.push(row);
  }

  // Typical-position order. Hero is pinned first regardless of arithmetic; the
  // rest sort by where they typically appear, then by prevalence, then by name
  // so the output is deterministic.
  rows.sort((a, b) => {
    if (a.type === 'hero') return -1;
    if (b.type === 'hero') return 1;
    return (a.median_position - b.median_position)
      || (b.share - a.share)
      || a.type.localeCompare(b.type);
  });
  belowFloor.sort((a, b) => b.share - a.share || a.type.localeCompare(b.type));

  const otherHits = byType.get('other') ?? [];

  return {
    readable_pages: of,
    of_total: companies.length,
    floor,
    bands: rows,
    below_floor: belowFloor.map((r) => ({ type: r.type, carriers: r.carriers, of: r.of, share: r.share })),
    unclassified: {
      note:
        'Sections the classifier could not name are not drawn as a band. They are '
        + 'not a section a page publishes on purpose, they are the measure of what the '
        + 'reader here could not read.',
      pages_with_any: otherHits.length,
      of,
    },
    caveat:
      'A composite, not a page any company publishes: each band is a section type '
      + 'placed at its typical position, sized by how many pages carry it. Section '
      + 'types come from the classifier, so read it at that accuracy. It shows what '
      + 'the market converged on; the share that does NOT carry each band is stated '
      + 'beside it, because the page that leaves a common section out is often the '
      + 'more interesting one.',
  };
}

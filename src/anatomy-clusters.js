/**
 * Shape families: the recurring homepage shapes, found by clustering the
 * similarity graph, computed at build time.
 *
 * WHY CLUSTERS AND NOT A BLOB
 * ---------------------------
 * "Which pages are shaped alike" is a fuzzy question -- exact section sequences
 * are nearly unique across the corpus, so there is nothing to group on exactly.
 * But the edit-distance graph is not structureless: about a third of pages sit
 * close enough to a few others to form recognisable families (a feature grid
 * with a security section, a features-plus-integrations page, the classic
 * features/testimonial/logo/CTA marketing stack). This finds those families so
 * the map can name them instead of drawing an unlabelled cloud.
 *
 * HOW
 * ---
 * Connected components of the published k-nearest-neighbour graph, keeping only
 * edges below a distance threshold, so two pages are in the same family when a
 * short chain of genuinely-alike pages links them. A family is named only when
 * it reaches a minimum size; everything smaller is left as "near-unique", which
 * is most of the corpus and is stated rather than hidden.
 *
 * A family's characteristic sections are the non-hero section types that at
 * least half its members carry, which is what the label is built from. Like
 * everything here it rests on the classifier, so it inherits its accuracy.
 *
 * DETERMINISM
 * -----------
 * Union-find over slug-sorted input, components sorted by size then first slug,
 * members sorted by name. Same corpus, same families, same ids, same bytes.
 */

export function clusterShapes({ companies }, similarity, { threshold = 0.30, minSize = 4 } = {}) {
  const readable = companies.filter(
    (c) => Array.isArray(c.sections) && c.sections.length && similarity.neighbours[c.slug]
  );
  const bySlug = new Map(readable.map((c) => [c.slug, c]));
  const slugs = readable.map((c) => c.slug).sort((a, b) => a.localeCompare(b, 'en'));

  // Union-find over close-enough neighbour edges.
  const parent = new Map(slugs.map((s) => [s, s]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const s of slugs) {
    for (const e of similarity.neighbours[s] || []) {
      if (e.distance < threshold && bySlug.has(e.slug)) union(s, e.slug);
    }
  }

  const groups = new Map();
  for (const s of slugs) {
    const r = find(s);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  }

  const named = [...groups.values()]
    .filter((g) => g.length >= minSize)
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0], 'en'));

  const nodeCluster = {};
  for (const s of slugs) nodeCluster[s] = -1;

  const clusters = named.map((members, id) => {
    members.sort((a, b) => bySlug.get(a).name.localeCompare(bySlug.get(b).name, 'en'));
    for (const s of members) nodeCluster[s] = id;

    // Characteristic non-hero sections: carried by at least half the family.
    const freq = new Map();
    for (const s of members) {
      const types = new Set((bySlug.get(s).sections || []).map((x) => x.type));
      for (const t of types) {
        if (t === 'hero' || t === 'other') continue;
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
    const sections = [...freq.entries()]
      .filter(([, n]) => n / members.length >= 0.5)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([t]) => t);

    return {
      id,
      size: members.length,
      sections, // characteristic section TYPES; the view builds the label from the label map
      members: members.map((s) => ({ slug: s, name: bySlug.get(s).name })),
    };
  });

  const clustered = clusters.reduce((n, c) => n + c.size, 0);

  return {
    threshold,
    minSize,
    of: slugs.length,
    clustered,
    near_unique: slugs.length - clustered,
    clusters,
    nodeCluster,
    note:
      'Families are connected components of the neighbour graph below an edit-distance of '
      + `${threshold}, named only at ${minSize} members or more. Most pages are near-unique and left `
      + 'unfamilied. The section types come from the classifier, so a family inherits its accuracy.',
  };
}

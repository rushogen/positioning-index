/**
 * A three-dimensional arrangement of the similarity graph, computed at build time.
 *
 * WHY IT IS COMPUTED HERE AND NOT IN THE BROWSER
 * ----------------------------------------------
 * Same reason the 2D neighbour graph is: a layout the visitor's machine invents
 * on load is not part of the record and cannot be argued with. This runs once,
 * deterministically, and the coordinates are published in api/anatomy.json, so
 * the WebGL point cloud renders a fixed, checkable arrangement rather than a
 * fresh physics roll every time the page opens.
 *
 * CLUSTER-AWARE
 * -------------
 * An unguided force layout of this graph is a formless ball, because most pages
 * are only loosely alike. So the layout is seeded from the shape families found
 * in anatomy-clusters.js: each family is given its own anchor on a sphere, its
 * members start near that anchor, and a cohesion force keeps them together while
 * global repulsion pushes the families apart. The result is separated lobes a
 * reader can actually read, one per family, with the near-unique pages spread
 * around the outside.
 *
 * DETERMINISM
 * -----------
 * No Math.random anywhere. Anchors and seed offsets are closed-form (Fibonacci
 * spheres and fixed trig), and the integration is a fixed number of steps with
 * fixed constants. The same corpus produces the same coordinates to the rounded
 * digit, which keeps the build byte-identical between runs.
 *
 * WHAT IT SHOWS, AND WHAT IT DOES NOT
 * -----------------------------------
 * Distance in the cloud is a readable arrangement of a graph, not a measurement.
 * Two dots sit near each other because the springs and the family cohesion
 * resolved that way, not because a coordinate axis says so. The real figures are
 * the edit distances in `similarity.neighbours`, and it inherits the classifier's
 * accuracy like everything derived from the section sequences.
 */

/** A point on a Fibonacci sphere of the given count, scaled to `r`. Closed form, no random. */
function fibPoint(i, count, r) {
  const y = count > 1 ? 1 - (i / (count - 1)) * 2 : 0;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * i;
  return { x: Math.cos(theta) * rad * r, y: y * r, z: Math.sin(theta) * rad * r };
}

/** A small deterministic offset so co-seeded nodes never start on the same point. */
function jitter(i, amp) {
  return {
    x: Math.cos(i * 2.399) * amp,
    y: Math.sin(i * 1.703) * amp,
    z: Math.cos(i * 0.734 + 1.1) * amp,
  };
}

/** Levenshtein-derived neighbour edges, de-duplicated, as index pairs. */
function edgesFrom(order, neighbours) {
  const index = new Map(order.map((slug, i) => [slug, i]));
  const seen = new Set();
  const edges = [];
  for (const [slug, near] of Object.entries(neighbours)) {
    const a = index.get(slug);
    if (a === undefined) continue;
    for (const n of near) {
      const b = index.get(n.slug);
      if (b === undefined) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, distance: n.distance });
    }
  }
  return edges;
}

/**
 * A deterministic, cluster-aware 3D force layout of the similarity graph.
 *
 * @param {Array} companies
 * @param {{neighbours: Record<string, {slug:string,distance:number}[]>}} similarity
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.nodeCluster]  slug -> family id (-1 = near-unique)
 * @param {number} [opts.clusterCount]  number of named families
 * @returns {{ method:string, radius:number, nodes:Array<{slug,name,segment,cluster,x,y,z}> }}
 */
export function layout3d(companies, similarity, { iterations = 500, radius = 100, nodeCluster = null, clusterCount = 0 } = {}) {
  const nodes = companies
    .filter((c) => Array.isArray(c.sections) && c.sections.length && similarity.neighbours[c.slug])
    .map((c) => ({ slug: c.slug, name: c.name, segment: c.segment ?? null, cluster: nodeCluster ? (nodeCluster[c.slug] ?? -1) : -1 }))
    .sort((a, b) => a.slug.localeCompare(b.slug, 'en'));

  const n = nodes.length;
  if (n === 0) return { method: METHOD, radius, nodes: [] };

  const order = nodes.map((d) => d.slug);
  const edges = edgesFrom(order, similarity.neighbours);

  // Family anchors on a sphere. A near-unique node (cluster -1) has no anchor and
  // is seeded on the outer sphere by its own index instead.
  const anchors = Array.from({ length: Math.max(1, clusterCount) }, (_, c) => fibPoint(c, Math.max(1, clusterCount), radius * 0.62));
  const pos = nodes.map((d, i) => {
    if (d.cluster >= 0 && d.cluster < anchors.length) {
      const a = anchors[d.cluster];
      const j = jitter(i, radius * 0.14);
      return { x: a.x + j.x, y: a.y + j.y, z: a.z + j.z };
    }
    const p = fibPoint(i, n, radius * 0.98);
    return { x: p.x, y: p.y, z: p.z };
  });

  const kRepel = radius * radius * 0.85;
  const kSpring = 0.05;
  const kCohesion = 0.045;
  const damping = 0.85;
  const vel = pos.map(() => ({ x: 0, y: 0, z: 0 }));

  // Per-family centroid, recomputed each step for the cohesion force.
  const centroid = () => {
    const sum = anchors.map(() => ({ x: 0, y: 0, z: 0, n: 0 }));
    for (let i = 0; i < n; i++) {
      const c = nodes[i].cluster;
      if (c >= 0 && c < sum.length) { sum[c].x += pos[i].x; sum[c].y += pos[i].y; sum[c].z += pos[i].z; sum[c].n++; }
    }
    for (const s of sum) if (s.n) { s.x /= s.n; s.y /= s.n; s.z /= s.n; }
    return sum;
  };

  for (let step = 0; step < iterations; step++) {
    const force = pos.map(() => ({ x: 0, y: 0, z: 0 }));
    const cen = centroid();

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dz = pos[i].z - pos[j].z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.01) { dx = 0.1; dy = 0.05; dz = 0.02; d2 = 0.0129; }
        const d = Math.sqrt(d2);
        const f = kRepel / d2;
        force[i].x += (dx / d) * f; force[i].y += (dy / d) * f; force[i].z += (dz / d) * f;
        force[j].x -= (dx / d) * f; force[j].y -= (dy / d) * f; force[j].z -= (dz / d) * f;
      }
    }

    for (const e of edges) {
      const rest = radius * (0.2 + e.distance * 0.9);
      let dx = pos[e.b].x - pos[e.a].x;
      let dy = pos[e.b].y - pos[e.a].y;
      let dz = pos[e.b].z - pos[e.a].z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      const f = kSpring * (d - rest);
      force[e.a].x += (dx / d) * f; force[e.a].y += (dy / d) * f; force[e.a].z += (dz / d) * f;
      force[e.b].x -= (dx / d) * f; force[e.b].y -= (dy / d) * f; force[e.b].z -= (dz / d) * f;
    }

    // Family cohesion: pull each clustered node toward its family's centroid so
    // the lobes stay tight against the global repulsion pushing everything apart.
    for (let i = 0; i < n; i++) {
      const c = nodes[i].cluster;
      if (c < 0 || c >= cen.length || !cen[c].n) continue;
      force[i].x += (cen[c].x - pos[i].x) * kCohesion;
      force[i].y += (cen[c].y - pos[i].y) * kCohesion;
      force[i].z += (cen[c].z - pos[i].z) * kCohesion;
    }

    const cool = 1 - step / iterations;
    const stepSize = 0.85 * cool + 0.02;
    for (let i = 0; i < n; i++) {
      vel[i].x = (vel[i].x + force[i].x) * damping;
      vel[i].y = (vel[i].y + force[i].y) * damping;
      vel[i].z = (vel[i].z + force[i].z) * damping;
      pos[i].x += vel[i].x * stepSize;
      pos[i].y += vel[i].y * stepSize;
      pos[i].z += vel[i].z * stepSize;
    }
  }

  // Recentre and rescale to a fixed radius, then round for byte-stability.
  const c = pos.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 });
  c.x /= n; c.y /= n; c.z /= n;
  let maxR = 0;
  for (const p of pos) { p.x -= c.x; p.y -= c.y; p.z -= c.z; maxR = Math.max(maxR, Math.hypot(p.x, p.y, p.z)); }
  const scale = maxR > 0 ? radius / maxR : 1;
  const round = (v) => Math.round(v * scale * 100) / 100;

  return {
    method: METHOD,
    radius,
    nodes: nodes.map((d, i) => ({
      slug: d.slug, name: d.name, segment: d.segment, cluster: d.cluster,
      x: round(pos[i].x), y: round(pos[i].y), z: round(pos[i].z),
    })),
  };
}

const METHOD =
  'A deterministic, cluster-aware 3D force layout of the neighbour graph: each shape family is '
  + 'seeded around its own anchor and held together by a cohesion force while every pair repels, so the '
  + 'families settle into separated lobes. Position is a readable arrangement, not a measurement; the real '
  + 'distances are in similarity.neighbours and the families in similarity.clusters.';

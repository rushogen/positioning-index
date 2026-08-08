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
 * DETERMINISM
 * -----------
 * No Math.random anywhere. Nodes are seeded onto a Fibonacci sphere (a closed
 * form, not a sample), and the force integration is a fixed number of steps with
 * fixed constants. The same corpus produces the same coordinates to the rounded
 * digit, which is what keeps the build byte-identical between runs.
 *
 * WHAT IT SHOWS, AND WHAT IT DOES NOT
 * -----------------------------------
 * Distance in the cloud is a readable arrangement of a graph, not a measurement,
 * exactly as in the flat map. Two dots sit near each other because the springs
 * between their neighbours resolved that way, not because a coordinate axis says
 * so. The real figures are the edit distances in `similarity.neighbours`; the
 * cloud is a way to see the clusters, and it inherits the classifier's accuracy
 * like everything else derived from the section sequences.
 */

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
 * A deterministic 3D force layout of the similarity graph.
 *
 * @param {Array<{slug:string,name:string,segment?:string,sections?:any[]}>} companies
 * @param {{neighbours: Record<string, {slug:string,distance:number}[]>}} similarity
 * @param {object} [opts]
 * @returns {{ method:string, radius:number, nodes:Array<{slug,name,segment,x,y,z}> }}
 */
export function layout3d(companies, similarity, { iterations = 400, radius = 100 } = {}) {
  // Only pages with a readable sequence are placed -- the same population the
  // neighbour graph compared, sorted by slug so the arrangement is stable.
  const nodes = companies
    .filter((c) => Array.isArray(c.sections) && c.sections.length && similarity.neighbours[c.slug])
    .map((c) => ({ slug: c.slug, name: c.name, segment: c.segment ?? null }))
    .sort((a, b) => a.slug.localeCompare(b.slug, 'en'));

  const n = nodes.length;
  if (n === 0) return { method: METHOD, radius, nodes: [] };

  const order = nodes.map((d) => d.slug);
  const edges = edgesFrom(order, similarity.neighbours);

  // Seed on a Fibonacci sphere: an even, deterministic spread with no random
  // draw, so two nodes never start on top of each other and the integration has
  // somewhere to push from.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const pos = nodes.map((_, i) => {
    const y = 1 - (i / Math.max(1, n - 1)) * 2; // 1 .. -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN * i;
    return { x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius };
  });

  // A spring-electrical model. Neighbours attract to a rest length that grows
  // with their edit distance (closer pages sit closer); every pair repels so the
  // cloud does not collapse. O(n^2) per step, ~180 nodes, trivial at build time.
  const kRepel = radius * radius * 0.9;
  const kSpring = 0.06;
  const damping = 0.85;
  const vel = pos.map(() => ({ x: 0, y: 0, z: 0 }));

  for (let step = 0; step < iterations; step++) {
    const force = pos.map(() => ({ x: 0, y: 0, z: 0 }));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dz = pos[i].z - pos[j].z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.01) { dx = 0.1; dy = 0.05; dz = 0.02; d2 = 0.0129; }
        const d = Math.sqrt(d2);
        const f = kRepel / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const fz = (dz / d) * f;
        force[i].x += fx; force[i].y += fy; force[i].z += fz;
        force[j].x -= fx; force[j].y -= fy; force[j].z -= fz;
      }
    }

    for (const e of edges) {
      const rest = radius * (0.25 + e.distance * 1.1);
      let dx = pos[e.b].x - pos[e.a].x;
      let dy = pos[e.b].y - pos[e.a].y;
      let dz = pos[e.b].z - pos[e.a].z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      const f = kSpring * (d - rest);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      const fz = (dz / d) * f;
      force[e.a].x += fx; force[e.a].y += fy; force[e.a].z += fz;
      force[e.b].x -= fx; force[e.b].y -= fy; force[e.b].z -= fz;
    }

    // Cooling: the step size shrinks over the run so the layout settles instead
    // of oscillating. Velocity is damped, not reset, so momentum carries.
    const cool = 1 - step / iterations;
    const stepSize = 0.9 * cool + 0.02;
    for (let i = 0; i < n; i++) {
      vel[i].x = (vel[i].x + force[i].x) * damping;
      vel[i].y = (vel[i].y + force[i].y) * damping;
      vel[i].z = (vel[i].z + force[i].z) * damping;
      pos[i].x += vel[i].x * stepSize;
      pos[i].y += vel[i].y * stepSize;
      pos[i].z += vel[i].z * stepSize;
    }
  }

  // Recentre on the centroid and rescale so the cloud fits a fixed radius,
  // regardless of how the forces happened to settle. Round to two decimals for
  // byte-stability -- finer than any pixel the renderer will use.
  const c = pos.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 });
  c.x /= n; c.y /= n; c.z /= n;
  let maxR = 0;
  for (const p of pos) {
    p.x -= c.x; p.y -= c.y; p.z -= c.z;
    maxR = Math.max(maxR, Math.hypot(p.x, p.y, p.z));
  }
  const scale = maxR > 0 ? radius / maxR : 1;
  const round = (v) => Math.round(v * scale * 100) / 100;

  return {
    method: METHOD,
    radius,
    nodes: nodes.map((d, i) => ({
      slug: d.slug,
      name: d.name,
      segment: d.segment,
      x: round(pos[i].x),
      y: round(pos[i].y),
      z: round(pos[i].z),
    })),
  };
}

const METHOD =
  'A deterministic 3D force layout of the same neighbour graph the flat map uses: '
  + 'neighbours attract to a rest length set by their edit distance, every pair repels, '
  + 'seeded on a Fibonacci sphere and integrated for a fixed number of steps with no random draw. '
  + 'Position is a readable arrangement, not a measurement; the real distances are in similarity.neighbours.';

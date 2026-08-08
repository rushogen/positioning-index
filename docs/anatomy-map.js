/*
  The similarity map: 200 pages arranged by how alike their shapes are.

  WHY THIS ONE USES D3 AND NOTHING ELSE HERE DOES
  -----------------------------------------------
  Every other chart on this site is hand-rolled SVG rendered at build time. A bar
  chart of ten groups does not need a library, and rendering it client-side would
  move a finding behind a fetch.

  This is the exception, and the reason is specific: laying out a graph so that
  similar things end up near each other is a physics problem, not a drawing
  problem. d3-force does it well and hand-rolling a velocity-Verlet integrator
  with a Barnes-Hut approximation to avoid a dependency would be daft. It is 17kB
  vendored -- d3-force and its three real dependencies, not the 280kB of d3 --
  served from this origin like everything else. See public/vendor/README.md.

  WHAT IT SHOWS, AND WHAT IT DOES NOT
  -----------------------------------
  Each dot is a company. Two dots are pulled together when one is among the
  other's six closest pages by section sequence, measured as normalised edit
  distance and computed at build time (src/anatomy-similarity.js), so the graph
  is published data rather than something invented on load.

  Distance on screen is NOT a measurement. A force layout is a readable
  arrangement of a graph, not a projection with axes, and two dots being close is
  the simulation resolving a tug-of-war between hundreds of springs. Read the
  clusters, never the pixels -- the panel gives the actual distances, and they are
  frequently high. A "nearest neighbour" at 0.71 is the least unlike page in the
  corpus, not a lookalike.

  It also inherits everything: the sequences come from a classifier that is right
  about half the time on non-hero sections. That caveat is on screen, not in a
  footnote.

  CONSTRAINTS, UNCHANGED
  ----------------------
  No third-party request. All rendering via createElementNS and text nodes, never
  innerHTML with data in it. Keyboard parity with the mouse. Motion respects
  prefers-reduced-motion.
*/

'use strict';

(function similarityMap() {
  const mount = document.getElementById('wf-map');
  if (!mount) return;

  const NS = 'http://www.w3.org/2000/svg';
  const W = 720;
  const H = 460;

  const svgEl = (tag, attrs, ...kids) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      n.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  };
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  };

  let booted = false;
  let nodes = [];
  let selected = null;
  let model = null;   // the loaded api/anatomy.json, kept in scope rather than on window

  function describe(slug) {
    const c = model.companies.find((x) => x.slug === slug);
    const near = (model.similarity.neighbours[slug] || []);
    const panel = document.getElementById('wf-map-panel');
    panel.replaceChildren();

    if (!c) return;

    panel.append(el('p', { class: 'wf-panel-title' }, c.name));
    panel.append(el('p', { class: 'wf-map-shape' },
      (c.sections || []).map((s) => model.labels[s.type] || s.type).join(' › ') || 'no readable sequence'));

    if (!near.length) {
      panel.append(el('p', { class: 'wf-empty' }, 'No comparable pages: this one has no readable sequence.'));
      return;
    }

    panel.append(el('p', { class: 'wf-group' }, 'Closest shapes'));
    const ul = el('ul', { class: 'wf-judged' });
    for (const n of near) {
      const other = model.companies.find((x) => x.slug === n.slug);
      if (!other) continue;
      ul.append(el('li', {},
        el('a', { href: `#/anatomy/${n.slug}` }, other.name),
        ' ',
        // The distance is shown because "closest" is meaningless without it.
        // Most of this corpus is not very alike, and a reader should see that.
        el('span', { class: 'wf-item-note' }, `distance ${n.distance.toFixed(2)}`)));
    }
    panel.append(ul);
    panel.append(el('p', { class: 'wf-caveat' },
      'Position on this map is a readable arrangement, not a measurement: read the '
      + 'clusters, not the pixels. The distances beside each name are the real figures. '
      + (model.accuracy
        ? `Sequences come from the classifier, which agreed with the human label on `
          + `${model.accuracy.nonHeroCorrect} of ${model.accuracy.nonHeroOf} non-hero sections.`
        : '')));
  }

  function select(slug, { focusNode = false } = {}) {
    selected = slug;
    for (const n of nodes) {
      const on = n.slug === slug;
      n.circle.setAttribute('aria-pressed', String(on));
      n.circle.classList.toggle('on', on);
    }
    describe(slug);
    if (focusNode) {
      const hit = nodes.find((n) => n.slug === slug);
      if (hit) hit.circle.focus();
    }
  }

  function render() {
    const sim = model.similarity;
    if (!sim || !sim.neighbours) return;

    const byslug = new Map(model.companies.map((c) => [c.slug, c]));
    const data = Object.keys(sim.neighbours)
      .filter((s) => byslug.has(s))
      .sort()
      .map((s) => ({ id: s, name: byslug.get(s).name, group: byslug.get(s).segment }));

    // One link per neighbour pair, de-duplicated: the relation is symmetric for
    // layout purposes even though "is in your top six" is not.
    const seen = new Set();
    const links = [];
    for (const [slug, near] of Object.entries(sim.neighbours)) {
      for (const n of near) {
        const key = slug < n.slug ? `${slug}|${n.slug}` : `${n.slug}|${slug}`;
        if (seen.has(key) || !byslug.has(n.slug)) continue;
        seen.add(key);
        // A shorter distance is a stronger spring.
        links.push({ source: slug, target: n.slug, distance: n.distance });
      }
    }

    const svg = svgEl('svg', {
      class: 'wf-map', viewBox: `0 0 ${W} ${H}`, width: '100%', height: 'auto',
      role: 'group', 'aria-labelledby': 'wf-map-title',
    });
    svg.append(svgEl('title', { id: 'wf-map-title' },
      `${data.length} pages arranged so that similarly shaped ones sit near each other.`));

    const linkLayer = svgEl('g', { class: 'wf-map-links', 'aria-hidden': 'true' });
    const nodeLayer = svgEl('g', { class: 'wf-map-nodes' });
    svg.append(linkLayer, nodeLayer);

    const lineFor = new Map();
    for (const l of links) {
      const line = svgEl('line', { class: 'wf-map-link' });
      linkLayer.append(line);
      lineFor.set(l, line);
    }

    nodes = data.map((d) => {
      const circle = svgEl('circle', {
        class: 'wf-map-node', r: 5, tabindex: '0', role: 'button',
        'aria-label': `${d.name}. Show its closest shapes.`,
        'data-slug': d.id,
      });
      nodeLayer.append(circle);
      return { slug: d.id, name: d.name, circle };
    });

    mount.replaceChildren(svg);

    // ---- the one thing d3 is here for
    const simulation = window.d3.forceSimulation(data)
      .force('link', window.d3.forceLink(links)
        .id((d) => d.id)
        // Similar pages sit closer. The 30..170 band keeps a distance-0 pair from
        // occupying the same pixel and a distance-1 pair from flying off screen.
        .distance((l) => 30 + l.distance * 140)
        .strength(0.35))
      .force('charge', window.d3.forceManyBody().strength(-38))
      .force('collide', window.d3.forceCollide(9))
      .force('centre', window.d3.forceCenter(W / 2, H / 2))
      .stop();

    // Run the simulation to completion synchronously rather than animating it.
    // A settling cloud of 180 dots is a decorative animation that says nothing,
    // it costs a few hundred frames of main thread, and under reduced-motion it
    // would have to be skipped anyway -- so nobody gets it.
    const ticks = Math.ceil(Math.log(0.001) / Math.log(1 - 0.0228));
    for (let i = 0; i < ticks; i++) simulation.tick();

    const xs = data.map((d) => d.x);
    const ys = data.map((d) => d.y);
    const pad = 16;
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const sx = (W - pad * 2) / Math.max(1, maxX - minX);
    const sy = (H - pad * 2) / Math.max(1, maxY - minY);
    const s = Math.min(sx, sy);
    const place = (d) => [pad + (d.x - minX) * s, pad + (d.y - minY) * s];

    for (const d of data) {
      const [x, y] = place(d);
      const hit = nodes.find((n) => n.slug === d.id);
      hit.circle.setAttribute('cx', x.toFixed(1));
      hit.circle.setAttribute('cy', y.toFixed(1));
    }
    for (const l of links) {
      const [x1, y1] = place(l.source);
      const [x2, y2] = place(l.target);
      const line = lineFor.get(l);
      line.setAttribute('x1', x1.toFixed(1)); line.setAttribute('y1', y1.toFixed(1));
      line.setAttribute('x2', x2.toFixed(1)); line.setAttribute('y2', y2.toFixed(1));
    }

    // ---- interaction. Keyboard parity: every dot is focusable and tab order is
    // alphabetical, which is a defensible order for a cloud that has none.
    for (const n of nodes) {
      n.circle.addEventListener('mouseenter', () => describe(n.slug));
      n.circle.addEventListener('focus', () => describe(n.slug));
      n.circle.addEventListener('click', () => select(n.slug));
      n.circle.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.slug); }
      });
    }

    const first = (location.hash.match(/^#\/anatomy\/([a-z0-9-]+)/) || [])[1];
    select(byslug.has(first) ? first : data[0].id);
  }

  async function boot() {
    if (booted) return;
    booted = true;
    try {
      const res = await fetch(mount.dataset.src, { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      model = await res.json();
      if (!window.d3 || !window.d3.forceSimulation) throw new Error('force layout unavailable');
      render();
    } catch {
      booted = false;
      mount.replaceChildren(el('p', { class: 'wf-noscript' },
        'The map could not load. The distances behind it are published in ',
        el('a', { href: 'api/anatomy.json' }, 'api/anatomy.json'),
        ' under "similarity".'));
    }
  }

  const onRoute = () => { if (location.hash.startsWith('#/anatomy')) boot(); };
  window.addEventListener('hashchange', onRoute);
  onRoute();
  // Re-selecting on hash change keeps the map in step with the explorer below it.
  window.addEventListener('hashchange', () => {
    const slug = (location.hash.match(/^#\/anatomy\/([a-z0-9-]+)/) || [])[1];
    if (booted && model && slug && slug !== selected && nodes.some((n) => n.slug === slug)) {
      select(slug);
    }
  });
})();

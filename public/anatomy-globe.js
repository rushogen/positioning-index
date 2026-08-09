/*
  The similarity cloud in three dimensions: the same 180 pages the flat map
  shows, floated into a sphere you can turn.

  WHY THIS IS THE ONLY WEBGL ON THE SITE, AND WHY IT IS OPTIONAL
  -------------------------------------------------------------
  Everything else here is either build-time SVG or the one d3-force map below.
  This view earns a GPU for a single reason: a graph laid out in 3D is genuinely
  easier to read when you can rotate it -- clusters that overlap from one angle
  separate from another, and a flat projection cannot give you that. That is the
  whole of the case for WebGL, so it is treated as pure enhancement. The findings
  on this page do not depend on it. If WebGL is missing, if the data will not
  fetch, or if anything throws, this file hides its own stage and gets out of the
  way, leaving the flat, keyboard-first map as the real, canonical view. Nothing
  here is ever the only way to reach a fact.

  WHAT IT SHOWS, AND WHAT IT DOES NOT
  -----------------------------------
  Each dot is a company, coloured by segment. Its position is the deterministic
  3D force layout computed at build time (src/anatomy-layout3d.js) and published
  in api/anatomy.json under similarity.layout3d -- a fixed, checkable arrangement,
  not a fresh physics roll on load.

  Distance in the cloud is NOT a measurement. Like the flat map, it is a readable
  arrangement of a spring graph: two dots sit near each other because the forces
  between their neighbours settled that way, not because an axis says so. The real
  figures are the edit distances in the panel, and they are frequently high. Read
  the clusters, never the gaps. And it inherits the classifier's accuracy like
  everything else derived from section sequences -- that caveat rides in the panel,
  not a footnote.

  CONSTRAINTS, UNCHANGED
  ----------------------
  No third-party request: Three.js is vendored and imported by relative path, no
  CDN, no import map, no addon (drag-to-rotate is hand-rolled). All panel DOM is
  built with createElement and text nodes, NEVER innerHTML with company data --
  a company name comes off a marketing page and is data, not markup. Motion
  respects prefers-reduced-motion. The canvas is aria-hidden; the flat map below
  is the keyboard and screen-reader path, and this one adds a light cycling parity.
*/

import * as THREE from './vendor/three.module.min.js';

(function similarityGlobe() {
  'use strict';

  const mount = document.getElementById('wf-globe');
  if (!mount) return;

  // ---- WebGL capability probe. A throwaway canvas so we never touch the real
  // one unless we know a context is obtainable. Any failure means "no globe".
  function webglOK() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext
        && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch {
      return false;
    }
  }

  const stage = mount.closest('.wf-globe-stage');
  if (!webglOK()) {
    if (stage) stage.hidden = true; // the flat map remains the answer
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // Small DOM helper mirroring anatomy-map.js: attributes and text nodes only,
  // never innerHTML. Company names are data and are appended as text.
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

  const cssVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };

  let booted = false;
  let model = null;

  // Scene state, filled in on boot.
  let renderer, scene, camera, group, points, highlight, raycaster;
  let layoutNodes = [];       // {slug,name,segment,x,y,z} in published order (by slug)
  let bySlug = new Map();
  let nameOrder = [];         // slug list sorted by name, for keyboard cycling
  let selected = null;        // currently described slug
  let pinned = false;         // Enter/Space locks selection against hover

  // ---- rendering. The gentle auto-rotate rides requestAnimationFrame, but the
  // FIRST frame -- and every frame that answers an interaction -- is painted
  // SYNCHRONOUSLY. rAF is throttled or fully paused in a backgrounded or
  // automation-driven tab, and a globe that only ever renders from inside rAF
  // shows nothing there. The flat map already runs its layout synchronously for
  // exactly this reason; the cloud must be visible on load without waiting for a
  // frame callback that may never come. The spin is enhancement layered on top.
  let running = false;
  let dragging = false;
  let autoRotate = !reduced;
  let resumeTimer = 0;

  function renderNow() {
    if (renderer && scene && camera) renderer.render(scene, camera);
  }
  function drawFrame() {
    running = true;
    const spin = autoRotate && !dragging && !reduced;
    if (spin) group.rotation.y += 0.0016;
    renderNow();
    if (spin) requestAnimationFrame(drawFrame);
    else running = false;
  }
  function kick() {
    // Paint immediately so the current state is visible even when rAF is paused.
    renderNow();
    // Then, only if we should be spinning, keep a rAF loop alive for the motion.
    if (!running && autoRotate && !dragging && !reduced) {
      running = true;
      requestAnimationFrame(drawFrame);
    }
  }

  // ---- soft round sprite for the dots, and a ring sprite for the highlight.
  // Drawn once into a 2D canvas so points read as glowing dots, not squares.
  function dotTexture() {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.8, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function ringTexture(hex) {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.strokeStyle = hex;
    g.lineWidth = 8;
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 12, 0, Math.PI * 2);
    g.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---- shape-family palette. The dots are coloured by which recurring shape
  // family they belong to, not by 28 near-identical segment hues -- that colour
  // was the reason the cloud read as noise. Hues are spaced by the golden ratio
  // for maximum separation between families; near-unique pages (no family) are a
  // dim neutral so the coloured lobes are what the eye lands on. The legend and
  // the floating labels below reuse these exact colours.
  // Populated in build(), once the model has been fetched -- referencing `model`
  // at module-eval time (before boot) would throw and take the whole globe down.
  let families = [];
  let clusterById = new Map();
  let clusterOfSlug = new Map();

  function familyLabel(c) {
    if (!c) return 'Near-unique';
    return c.sections && c.sections.length
      ? c.sections.map((t) => model.labels[t] || t).join(' + ')
      : 'Hero only';
  }
  function familyColor(id) {
    const c = new THREE.Color();
    if (id < 0) { c.setHSL(0, 0, darkMode ? 0.34 : 0.70, THREE.SRGBColorSpace); return c; }
    const sat = darkMode ? 0.66 : 0.70;
    const light = darkMode ? 0.63 : 0.50;
    c.setHSL((id * 0.61803398875) % 1, sat, light, THREE.SRGBColorSpace);
    return c;
  }
  const familyHex = (id) => '#' + familyColor(id).getHexString();
  function buildColors() {
    return layoutNodes.map((n) => familyColor(n.cluster));
  }

  // ---- the panel. With nothing selected it is the LEGEND -- the families, their
  // colours and sizes -- so the cloud is readable at a glance without hovering
  // 180 dots. With a company selected it is that page: its family, its section
  // shape, and its closest shapes with the real distances and #/anatomy links.
  // All text nodes; never innerHTML with data.
  function renderLegend(panel) {
    const cl = model.similarity.clusters;
    panel.append(el('p', { class: 'wf-group' }, 'Shape families'));
    const ul = el('ul', { class: 'wf-legend' });
    for (const c of families) {
      const dot = el('span', { class: 'wf-fam-dot' });
      dot.style.background = familyHex(c.id);
      ul.append(el('li', {}, dot, el('b', {}, familyLabel(c)),
        el('span', { class: 'wf-item-note' }, `${c.size} pages`)));
    }
    // The near-unique majority, named as a swatch too so it is not a silent gap.
    if (cl && cl.near_unique) {
      const dot = el('span', { class: 'wf-fam-dot' });
      dot.style.background = familyHex(-1);
      ul.append(el('li', { class: 'wf-legend-rest' }, dot, 'Near-unique',
        el('span', { class: 'wf-item-note' }, `${cl.near_unique} pages`)));
    }
    panel.append(ul);
    if (cl) panel.append(el('p', { class: 'wf-caveat' },
      `${cl.clustered} of ${cl.of} readable pages fall into ${families.length} recurring shapes; the other `
      + `${cl.near_unique} are near-unique. Hover or focus a dot for one page and its closest shapes. Position `
      + 'is a readable arrangement, not a measurement.'));
  }

  function describe(slug) {
    const panel = document.getElementById('wf-globe-panel');
    if (!panel) return;
    panel.replaceChildren();

    const c = model.companies.find((x) => x.slug === slug);
    if (!c) { renderLegend(panel); return; }
    const near = model.similarity.neighbours[slug] || [];

    panel.append(el('p', { class: 'wf-panel-title' }, c.name));

    // Which family this page is in -- the first thing to say, colour-matched to
    // its dot, or the honest "near-unique" when it is in none.
    const fid = clusterOfSlug.has(slug) ? clusterOfSlug.get(slug) : -1;
    const fam = fid >= 0 ? clusterById.get(fid) : null;
    const dot = el('span', { class: 'wf-fam-dot' });
    dot.style.background = familyHex(fid);
    panel.append(fam
      ? el('p', { class: 'wf-fam' }, dot, el('b', {}, familyLabel(fam)),
          el('span', { class: 'wf-item-note' }, `family of ${fam.size}`))
      : el('p', { class: 'wf-fam' }, dot, 'Near-unique shape — in no family'));

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
        el('span', { class: 'wf-item-note' }, `distance ${n.distance.toFixed(2)}`)));
    }
    panel.append(ul);
    panel.append(el('p', { class: 'wf-caveat' },
      'Position in this cloud is a readable arrangement, not a measurement: read the '
      + 'families, not the gaps. The distances beside each name are the real figures. '
      + (model.accuracy
        ? `Sequences come from the classifier, which agreed with the human label on `
          + `${model.accuracy.nonHeroCorrect} of ${model.accuracy.nonHeroOf} non-hero sections.`
        : '')));
  }

  // Move the highlight ring to a node and describe it. index is into layoutNodes.
  function selectIndex(i, { fromKeyboard = false } = {}) {
    if (i < 0 || i >= layoutNodes.length) return;
    const node = layoutNodes[i];
    selected = node.slug;
    highlight.position.set(node.x, node.y, node.z);
    highlight.visible = true;
    describe(node.slug);
    if (fromKeyboard) {
      // Turn the cloud so the picked node faces the camera-ish: rotate Y toward it.
      // Kept gentle and only on keyboard so mouse hover does not lurch the view.
      const target = -Math.atan2(node.x, node.z);
      group.rotation.y = target;
    }
    kick();
  }
  function selectSlug(slug, opts) {
    const i = layoutNodes.findIndex((n) => n.slug === slug);
    if (i >= 0) selectIndex(i, opts);
  }

  // ---- picking. Raycaster with a Points threshold in world units; we pick the
  // nearest hit and only re-describe when the node actually changes.
  function pickAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    group.updateMatrixWorld();
    const hits = raycaster.intersectObject(points, false);
    return hits.length ? hits[0].index : -1;
  }

  function sizeToMount() {
    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  }

  function markTouched() {
    if (!mount.classList.contains('is-touched')) mount.classList.add('is-touched');
  }

  function build() {
    const radius = (model.similarity.layout3d && model.similarity.layout3d.radius) || 100;

    // Family lookups, now that the model is loaded.
    families = (model.similarity.clusters && model.similarity.clusters.clusters) || [];
    clusterById = new Map(families.map((c) => [c.id, c]));
    clusterOfSlug = new Map(layoutNodes.map((n) => [n.slug, n.cluster]));

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    // Insert the canvas before the hint so the hint paints on top of it.
    const hint = mount.querySelector('.wf-globe-hint');
    if (hint) mount.insertBefore(canvas, hint);
    else mount.append(canvas);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    // Fit the whole cloud: distance = R / sin(fov/2), plus a little air.
    const dist = (radius / Math.sin((45 * Math.PI / 180) / 2)) * 1.12;
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);

    group = new THREE.Group();
    scene.add(group);

    // ---- points
    const n = layoutNodes.length;
    const positions = new Float32Array(n * 3);
    const colorArr = new Float32Array(n * 3);
    const colors = buildColors();
    for (let i = 0; i < n; i++) {
      positions[i * 3] = layoutNodes[i].x;
      positions[i * 3 + 1] = layoutNodes[i].y;
      positions[i * 3 + 2] = layoutNodes[i].z;
      colorArr[i * 3] = colors[i].r;
      colorArr[i * 3 + 1] = colors[i].g;
      colorArr[i * 3 + 2] = colors[i].b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

    const dotMat = new THREE.PointsMaterial({
      size: radius * 0.05,
      sizeAttenuation: true,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.02,
    });
    points = new THREE.Points(geo, dotMat);
    group.add(points);

    // ---- edges, but ONLY between genuinely-alike pairs (below the family
    // threshold), de-duplicated. Drawing all six neighbours of every page was
    // most of why the cloud read as noise: a page's "sixth closest" can still be
    // very unlike it. Restricting to close pairs means the lines trace the
    // families instead of hazing over them.
    const threshold = (model.similarity.clusters && model.similarity.clusters.threshold) || 0.34;
    const idx = new Map(layoutNodes.map((d, i) => [d.slug, i]));
    const seen = new Set();
    const linePos = [];
    for (const [slug, near] of Object.entries(model.similarity.neighbours)) {
      const a = idx.get(slug);
      if (a === undefined) continue;
      for (const nb of near) {
        if (nb.distance >= threshold) continue;
        const b = idx.get(nb.slug);
        if (b === undefined) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        linePos.push(
          layoutNodes[a].x, layoutNodes[a].y, layoutNodes[a].z,
          layoutNodes[b].x, layoutNodes[b].y, layoutNodes[b].z);
      }
    }
    if (linePos.length) {
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
      const lmat = new THREE.LineBasicMaterial({
        color: new THREE.Color(cssVar('--ink-3', '#7a8089')),
        transparent: true,
        opacity: darkMode ? 0.28 : 0.24,
        depthWrite: false,
      });
      group.add(new THREE.LineSegments(lgeo, lmat));
    }

    // ---- highlight ring, accent-coloured, faces the camera.
    const ringMat = new THREE.SpriteMaterial({
      map: ringTexture(cssVar('--accent', '#1c4fd8')),
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    highlight = new THREE.Sprite(ringMat);
    highlight.scale.setScalar(radius * 0.14);
    highlight.visible = false;
    group.add(highlight);

    // ---- floating family labels, one per lobe, so a reader can name a cluster
    // without hovering it. Billboards (Sprites always face the camera), added to
    // the group so each label rides its own lobe as the cloud turns, drawn on
    // top (depthTest off) so a label is never lost behind its own dots.
    const labelSprite = (text, hex) => {
      const fs = 34;
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = `600 ${fs}px Roboto, system-ui, sans-serif`;
      const pad = 10;
      const w = Math.ceil(measure.measureText(text).width) + pad * 2;
      const h = fs + pad * 2;
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      g.font = `600 ${fs}px Roboto, system-ui, sans-serif`;
      g.textBaseline = 'middle';
      g.fillStyle = darkMode ? 'rgba(20,21,26,0.74)' : 'rgba(251,250,248,0.82)';
      if (g.roundRect) { g.beginPath(); g.roundRect(0, 0, w, h, 9); g.fill(); } else { g.fillRect(0, 0, w, h); }
      g.fillStyle = hex;
      g.fillText(text, pad, h / 2 + 1);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
      const k = radius * 0.0065;
      sp.scale.set(w * k, h * k, 1);
      return sp;
    };
    const cen = new Map();
    for (const nd of layoutNodes) {
      if (nd.cluster < 0) continue;
      const a = cen.get(nd.cluster) || { x: 0, y: 0, z: 0, n: 0 };
      a.x += nd.x; a.y += nd.y; a.z += nd.z; a.n++;
      cen.set(nd.cluster, a);
    }
    for (const c of families) {
      const a = cen.get(c.id);
      if (!a || !a.n) continue;
      const cx = a.x / a.n, cy = a.y / a.n, cz = a.z / a.n;
      const len = Math.hypot(cx, cy, cz) || 1;
      const push = radius * 0.18;
      const sp = labelSprite(familyLabel(c), familyHex(c.id));
      sp.position.set(cx + (cx / len) * push, cy + (cy / len) * push + radius * 0.12, cz + (cz / len) * push);
      group.add(sp);
    }

    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: radius * 0.035 };

    sizeToMount();
    if ('ResizeObserver' in window) new ResizeObserver(sizeToMount).observe(mount);
    else window.addEventListener('resize', sizeToMount);
  }

  function wireInteraction() {
    const canvas = renderer.domElement;
    let downX = 0, downY = 0, moved = false, activeId = null;
    let lastHover = -1;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      activeId = e.pointerId;
      downX = e.clientX;
      downY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      markTouched();
      clearTimeout(resumeTimer);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (dragging && e.pointerId === activeId) {
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        group.rotation.y += dx * 0.006;
        // Clamp vertical tilt so the cloud never flips over.
        group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2,
          group.rotation.x + dy * 0.006));
        downX = e.clientX;
        downY = e.clientY;
        kick();
        return;
      }
      // Hover pick when not dragging and not pinned.
      if (pinned) return;
      const hit = pickAt(e.clientX, e.clientY);
      if (hit !== lastHover) {
        lastHover = hit;
        if (hit >= 0) selectIndex(hit);
      }
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      if (activeId !== null) {
        try { canvas.releasePointerCapture(activeId); } catch { /* ignore */ }
      }
      activeId = null;
      // Resume the gentle spin after a pause (never under reduced motion).
      if (!reduced) {
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => { autoRotate = true; kick(); }, 2600);
      }
      kick();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => { if (!dragging) return; endDrag(); });

    // Pause auto-rotate the moment a drag starts.
    canvas.addEventListener('pointerdown', () => { autoRotate = false; });

    // ---- keyboard parity on the mount. Focus shows the first node; arrows
    // cycle by name; Enter/Space pin. Full 3D nav is not the goal -- the flat
    // map is the primary keyboard experience -- but cycling keeps this reachable.
    let kbIndex = -1;
    const showKb = (i) => {
      kbIndex = (i + nameOrder.length) % nameOrder.length;
      selectSlug(nameOrder[kbIndex], { fromKeyboard: true });
    };
    mount.addEventListener('focus', () => {
      if (selected === null && nameOrder.length) showKb(0);
    });
    mount.addEventListener('keydown', (e) => {
      if (!nameOrder.length) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault(); markTouched(); autoRotate = false;
          showKb(kbIndex < 0 ? 0 : kbIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault(); markTouched(); autoRotate = false;
          showKb(kbIndex < 0 ? 0 : kbIndex - 1);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          pinned = !pinned;
          break;
        default:
          break;
      }
    });
  }

  async function boot() {
    if (booted) return;
    booted = true;
    try {
      const res = await fetch(mount.dataset.src, { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      model = await res.json();

      const l3d = model.similarity && model.similarity.layout3d;
      if (!l3d || !Array.isArray(l3d.nodes) || !l3d.nodes.length) {
        throw new Error('no 3D layout');
      }
      layoutNodes = l3d.nodes;
      bySlug = new Map(layoutNodes.map((n) => [n.slug, n]));
      nameOrder = layoutNodes
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .map((n) => n.slug);

      build();
      wireInteraction();

      // Empty-state panel until something is picked.
      describe(null);

      // Deep link: select the requested node immediately.
      const deep = (location.hash.match(/^#\/anatomy\/([a-z0-9-]+)/) || [])[1];
      if (deep && bySlug.has(deep)) selectSlug(deep, { fromKeyboard: true });

      kick(); // first paint (starts the spin unless reduced motion)
    } catch {
      // Fail silently and cleanly: hide our stage, leave the flat map as the
      // canonical view. Nothing is thrown at a user who has no console.
      if (stage) stage.hidden = true;
    }
  }

  // The data file is ~310kB and must not load for someone who never scrolls
  // here. Boot lazily via whenNear (robust in backgrounded tabs); boot at once
  // for a deep link that lands straight on the cloud.
  if (location.hash.startsWith('#/anatomy') || typeof window.whenNear !== 'function') {
    boot();
  } else {
    window.whenNear(mount, boot, 500);
  }

  // Keep the cloud in step with the explorer below on hash changes.
  window.addEventListener('hashchange', () => {
    if (!booted) { if (location.hash.startsWith('#/anatomy')) boot(); return; }
    const slug = (location.hash.match(/^#\/anatomy\/([a-z0-9-]+)/) || [])[1];
    if (model && slug && slug !== selected && bySlug.has(slug)) {
      selectSlug(slug, { fromKeyboard: true });
    }
  });
})();

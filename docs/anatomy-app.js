/*
  The page-anatomy explorer.

  WHAT THIS IS AND WHY IT IS NOT IN THE DOCUMENT
  ----------------------------------------------
  Everything else on this site is written into index.html by bin/build-site.js
  and is on screen before a line of script runs. That rule exists because the
  findings are the product, and gating a finding behind a fetch means a page that
  says nothing until a JSON file arrives.

  This is not a finding. It is a tool for looking at one page at a time, and the
  distinction is load-bearing: the distributions above it -- what sits in
  position two, what a page carries, how big pages are -- are all in the markup
  and always will be. Inlining all 200 wireframes so that one could be shown at a
  time cost 3.5MB of HTML, which is 3.5MB of parsing on a phone to display 17kB
  of it. So the shapes are drawn here, from api/anatomy.json, which is the same
  file a reader without JavaScript is pointed at.

  CONSTRAINTS, UNCHANGED FROM app.js
  ----------------------------------
  No framework, no CDN, no build step, no third-party request of any kind. All
  rendering goes through createElement / createElementNS and text nodes, never
  innerHTML with data in it: page content is data we display, never instructions
  we follow, and there is a company in this corpus that serves a page addressed
  to automated agents.

  WHAT IT REUSES
  --------------
  app.js already owns the interaction for a wireframe figure -- hover, focus,
  arrow keys, pin, escape, the live region -- and it is browser-verified. This
  file builds the same markup contract it expects (.wf-figure containing an svg
  of .wf-sec blocks, a .wf-panel, and a script.wf-data island) and hands each
  freshly built figure to initWireframe(). Rewriting that interaction here would
  have been a second implementation of a solved problem.

  DEEP LINKS
  ----------
  #/anatomy/linear selects Linear. The whole point of this archive is that a
  claim can be pointed at, so a shape somebody wants to show a colleague needs an
  address.
*/

'use strict';

(function anatomyExplorer() {
  const mount = document.getElementById('wf-app');
  if (!mount) return;

  const NS = 'http://www.w3.org/2000/svg';
  const PAD = 8;
  const GAP = 3;

  const el = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return node;
  };

  const svgEl = (tag, attrs, ...kids) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return node;
  };

  const state = { model: null, slug: null, companies: [], byslug: new Map() };

  // ------------------------------------------------------------------ drawing

  /**
   * Block height is proportional to the section's share of ITS OWN page, not of
   * the corpus. Scaled against the corpus maximum a single 23,000-word outlier
   * flattens every other page to the floor and all 200 shapes come out
   * identical, which is a chart of nothing.
   */
  function blockHeight(words, maxWords, geom) {
    const min = geom.minBlock;
    const max = geom.maxBlock;
    if (!maxWords) return min;
    return Math.min(max, Math.max(min, Math.round((words / maxWords) * max)));
  }

  function drawWireframe(company, geom, labels) {
    const secs = company.sections || [];
    const maxWords = secs.reduce((m, s) => Math.max(m, s.words || 0), 0) || 1;
    const width = geom.width;

    if (!secs.length) {
      const svg = svgEl('svg', {
        class: 'wf', viewBox: `0 0 ${width} 44`, width: '100%', height: 'auto',
        role: 'group', 'aria-labelledby': 'wf-title-live',
      });
      svg.append(svgEl('title', { id: 'wf-title-live' }, `${company.name}: no readable section sequence.`));
      svg.append(svgEl('text', {
        class: 'wf-empty', x: PAD, y: 22, 'dominant-baseline': 'central',
      }, 'No readable section sequence'));
      return svg;
    }

    let y = 0;
    const blocks = [];
    for (const sec of secs.slice().sort((a, b) => a.position - b.position)) {
      const hgt = blockHeight(sec.words || 0, maxWords, geom);
      const label = labels[sec.type] || sec.type;
      const heading = sec.heading ? ` Heading: "${sec.heading}".` : '';
      const g = svgEl('g', {
        class: 'wf-sec',
        'data-section': String(sec.position),
        'data-type': sec.type,
        tabindex: '0',
        role: 'button',
        'aria-label': `Section ${sec.position} of ${secs.length}: ${label}.${heading} ${sec.words} words.`,
        transform: `translate(0 ${y})`,
      });
      g.append(svgEl('rect', {
        class: `wf-block wf-t-${sec.type}`, x: 0, y: 0, width, height: hgt, rx: 3,
      }));
      // The type name is inside the block, so the palette never has to carry
      // meaning on its own.
      if (hgt >= 20) {
        g.append(svgEl('text', {
          class: 'wf-label', x: PAD, y: Math.round(hgt / 2), 'dominant-baseline': 'central',
        }, label));
      }
      blocks.push(g);
      y += hgt + GAP;
    }

    const svg = svgEl('svg', {
      class: 'wf', viewBox: `0 0 ${width} ${Math.max(0, y - GAP)}`,
      width: '100%', height: 'auto', role: 'group', 'aria-labelledby': 'wf-title-live',
    });
    svg.append(svgEl('title', { id: 'wf-title-live' },
      `${company.name}: ${secs.length} sections, top to bottom.`));
    for (const b of blocks) svg.append(b);
    return svg;
  }

  // ------------------------------------------------------------------- figure

  function buildFigure(company) {
    const { geometry, labels, insights } = state.model;
    const insight = insights[company.slug] || { sections: {}, page: null };

    const figure = el('figure', { class: 'wf-figure', 'data-slug': company.slug });

    figure.append(el('figcaption', { class: 'wf-cap' },
      el('a', { href: `#/company/${company.slug}` }, company.name),
      el('span', { class: 'wf-cap-meta' },
        (company.sections && company.sections.length)
          ? `${company.sections.length} sections`
          : 'no readable sequence')));

    figure.append(drawWireframe(company, geometry, labels));

    const panel = el('div', { class: 'wf-panel', role: 'region', 'aria-live': 'polite', tabindex: '-1' });
    panel.append(el('p', { class: 'wf-empty' },
      'Hover, tap or focus a block to see how that section compares.'));
    figure.append(panel);

    // Page-level measured facts sit under the shape, because they describe the
    // whole page and are counted rather than judged.
    const page = insight.page;
    if (page && page.measured && page.measured.length) {
      const ul = el('ul', { class: 'wf-page' });
      for (const m of page.measured) {
        if (!m.comparison) continue;
        ul.append(el('li', {}, m.comparison));
      }
      if (ul.childElementCount) figure.append(ul);
    }

    // The island app.js reads. Building it here rather than fetching per company
    // keeps one code path for the interaction, whether the figure came from the
    // build or from this file.
    const island = el('script', { type: 'application/json', class: 'wf-data' });
    island.textContent = JSON.stringify(insight.sections || {});
    figure.append(island);

    return figure;
  }

  // -------------------------------------------------------------------- chrome

  function buildControls() {
    const bar = el('div', { class: 'wf-controls' });

    const search = el('input', {
      type: 'search', id: 'wf-search', placeholder: 'Search 200 companies',
      autocomplete: 'off', 'aria-label': 'Search companies',
    });
    const select = el('select', { id: 'wf-pick', 'aria-label': 'Choose a company' });

    bar.append(
      el('label', { for: 'wf-search' }, 'Company ', search),
      el('label', { for: 'wf-pick', class: 'wf-sr' }, 'Choose a company'),
      select,
      el('button', { type: 'button', id: 'wf-prev', 'aria-label': 'Previous company' }, '←'),
      el('button', { type: 'button', id: 'wf-next', 'aria-label': 'Next company' }, '→'),
      el('span', { class: 'wf-count', id: 'wf-count' }),
    );
    return { bar, search, select };
  }

  function fillSelect(select, list) {
    select.replaceChildren();
    for (const c of list) {
      select.append(el('option', { value: c.slug }, `${c.name}${c.sections ? '' : ' — unreadable'}`));
    }
  }

  // --------------------------------------------------------------------- state

  function show(slug, { push = true } = {}) {
    const company = state.byslug.get(slug);
    if (!company) return;
    state.slug = slug;

    const stage = document.getElementById('wf-stage');
    const figure = buildFigure(company);
    stage.replaceChildren(figure);

    // app.js owns the interaction; hand it the freshly built markup.
    if (typeof initWireframe === 'function') {
      try { initWireframe(figure); } catch { /* a dead panel must not kill the page */ }
    }

    const select = document.getElementById('wf-pick');
    if (select && select.value !== slug) select.value = slug;

    if (push) {
      const want = `#/anatomy/${slug}`;
      if (location.hash !== want) history.replaceState(null, '', want);
    }
  }

  function step(delta) {
    const list = state.companies;
    const i = list.findIndex((c) => c.slug === state.slug);
    const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
    if (next) show(next.slug);
  }

  // ----------------------------------------------------------------------- boot

  function render(model) {
    state.model = model;
    state.companies = (model.companies || []).slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    state.byslug = new Map(state.companies.map((c) => [c.slug, c]));

    const { bar, search, select } = buildControls();
    const stage = el('div', { id: 'wf-stage' });

    mount.replaceChildren(bar, stage);
    fillSelect(select, state.companies);

    const count = document.getElementById('wf-count');
    const applySearch = () => {
      const needle = search.value.trim().toLowerCase();
      const list = needle
        ? state.companies.filter((c) => c.name.toLowerCase().includes(needle))
        : state.companies;
      fillSelect(select, list);
      count.textContent = needle ? `${list.length} of ${state.companies.length}` : `${state.companies.length} companies`;
      if (list.length && !list.some((c) => c.slug === state.slug)) show(list[0].slug);
    };

    search.addEventListener('input', applySearch);
    select.addEventListener('change', () => show(select.value));
    document.getElementById('wf-prev').addEventListener('click', () => step(-1));
    document.getElementById('wf-next').addEventListener('click', () => step(1));

    count.textContent = `${state.companies.length} companies`;

    const fromHash = (location.hash.match(/^#\/anatomy\/([a-z0-9-]+)/) || [])[1];
    show(state.byslug.has(fromHash) ? fromHash : state.companies[0].slug, { push: false });
  }

  let loaded = false;
  async function boot() {
    if (loaded) return;
    loaded = true;
    try {
      const res = await fetch(mount.dataset.src, { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      render(await res.json());
    } catch (err) {
      loaded = false;
      mount.replaceChildren(el('p', { class: 'wf-noscript' },
        'The explorer could not load its data. The same data is at ',
        el('a', { href: 'api/anatomy.json' }, 'api/anatomy.json'),
        '.'));
    }
  }

  // Load only when the view is actually opened: a 280kB fetch on every visit to
  // the front page would be a cost paid by readers who never open this tool.
  //
  // Once loaded, a hash change still has to be honoured -- otherwise
  // #/anatomy/linear only selects Linear on a cold load, and a link somebody
  // shares does nothing for a reader already on the page. That is the whole
  // point of giving a shape an address.
  const onRoute = () => {
    if (!location.hash.startsWith('#/anatomy')) return;
    if (!loaded) { boot(); return; }
    const slug = (location.hash.match(/^#\/anatomy\/([a-z0-9-]+)/) || [])[1];
    if (slug && state.byslug.has(slug) && slug !== state.slug) show(slug, { push: false });
  };
  window.addEventListener('hashchange', onRoute);
  onRoute();
})();

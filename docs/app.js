/*
  The public index, in plain JavaScript.

  WHAT THIS FILE IS NOT RESPONSIBLE FOR
  ------------------------------------
  The landing view. Every chart, number, coverage note and table of companies on
  "The state of positioning" is written into index.html by bin/build-site.js and
  is already on screen when this file starts. Nothing below renders it, and with
  scripting switched off it still reads correctly. That is deliberate: the
  findings are the product, and gating them behind a fetch would mean a page
  that says nothing until a JSON file arrives.

  What is left here is the three secondary views -- the change feed, the company
  list, the crawl health table -- and the router between them.

  No framework, no build step, no CDN. Three reasons, in order of how much they
  actually mattered:

  1. Every third-party request from this page would disclose the visitor's IP to
     someone else, which under TDDDG section 25 turns a static page into one
     that needs a consent dialogue. Self-hosting everything means there is
     nothing to consent to.
  2. There is no server. This is GitHub Pages serving files that bin/build-site.js
     generated from data/, so anything the page cannot do with a static file it
     does not do at all.
  3. The page is four tables and a list. A framework would be more code than the
     thing it renders.

  There is no API either: the "endpoints" below are files on disk, and every
  path is relative so the site works at a repository subpath
  (user.github.io/positioning-index/) exactly as it does at a domain root.
  Filtering happens in the browser because a static file cannot take a query
  string.

  All rendering goes through h() / text nodes, never innerHTML with data in it,
  so a headline containing markup is displayed rather than executed. Page
  content is data we display, never instructions we follow -- worth stating
  because at least one tracked company (ramp.com) publishes a page addressed to
  automated agents offering them an incentive.
*/

'use strict';

const API = {
  stats: 'api/stats.json',
  changes: 'api/changes.json',
  retractions: 'api/retractions.json',
  companies: 'api/companies.json',
  health: 'api/health.json',
  company: (slug) => `api/company/${encodeURIComponent(slug)}.json`,
};

const state = {
  stats: null, changes: null, retracted: null, health: null,
  signalMeta: {}, signalFilter: '', segmentFilter: '',
};

// --------------------------------------------------------------- utilities

/** Build an element. Children are appended as text nodes unless they are Nodes. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') throw new Error('refused: use text nodes');
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const NBSP = ' ';

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(+d)) return iso;
  return d.toISOString().slice(0, 10);
}

function relative(iso) {
  if (!iso) return 'never';
  const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  const hours = (Date.now() - +d) / 3600_000;
  if (Number.isNaN(hours)) return iso;
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${Math.floor(hours)}${NBSP}hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}${NBSP}days ago`;
}

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));

const signalLabel = (name) => state.signalMeta[name]?.label ?? name.replace(/_/g, ' ');

// ------------------------------------------------------------------ header

async function loadStats() {
  const s = await getJSON(API.stats);
  state.stats = s;
  state.signalMeta = s.signals || {};

  const set = (key, value, small) => {
    for (const el of $$(`[data-stat="${key}"]`)) {
      el.textContent = value;
      if (small) el.classList.add('small');
    }
  };
  // These now live on the crawl-health tab rather than the masthead. Crawl
  // counters are diagnostics: they say whether the numbers on the front page
  // can be trusted, which is not the same thing as being the point.
  set('observations', fmtNum(s.observations));
  set('runs', fmtNum(s.runs));
  set('changes', fmtNum(s.changes));
  set('retracted_changes', fmtNum(s.retracted_changes));
  set('last_successful_fetch', relative(s.last_successful_fetch), true);

  // The banner is the honesty valve: if the crawl is unhealthy, the page says
  // so at the top rather than presenting a quiet, plausible, stale index.
  const banner = $('#crawl-banner');
  const problems = [];
  const staleHours = s.last_successful_fetch
    ? (Date.now() - Date.parse(s.last_successful_fetch)) / 3600_000
    : Infinity;
  if (!Number.isFinite(staleHours) || staleHours > 36) {
    problems.push(
      'No page has been read successfully in over 36 hours, so everything below may be out of date. ' +
      'This index is crawled on demand rather than by a hosted scheduler: it advances when a run is ' +
      'triggered, and says so plainly when one has not been.'
    );
  }
  if (s.suspect_signals > 0) {
    problems.push(`${s.suspect_signals} signal${s.suspect_signals === 1 ? ' is' : 's are'} currently flagged as a suspected extraction failure and excluded from change detection.`);
  }
  if (s.errors_24h > 0 || s.blocked_24h > 0) {
    problems.push(`In the last 24 hours: ${s.errors_24h} fetch error${s.errors_24h === 1 ? '' : 's'}, ${s.blocked_24h} blocked.`);
  }
  if (problems.length) {
    banner.textContent = problems.join(' ');
    banner.hidden = false;
  }

  const sel = $('#signal-filter');
  for (const [name, meta] of Object.entries(state.signalMeta)) {
    sel.appendChild(h('option', { value: name }, meta.label));
  }
}

// -------------------------------------------------------------------- feed

function renderChange(c) {
  const isText = c.before_value != null && c.after_value != null;
  return h('li', { class: `change${c.retracted ? ' retracted' : ''}` },
    h('div', { class: 'change-head' },
      h('span', { class: 'co' }, h('a', { href: `#/company/${c.slug}` }, c.name)),
      h('span', { class: `tag ${c.change_type}` }, c.change_type),
      h('span', { class: 'tag' }, signalLabel(c.signal)),
      c.oscillating ? h('span', { class: 'tag oscillating', title: 'This page has held this value before. Most likely an A/B test cycling rather than a repositioning.' }, 'A/B?') : null,
      !c.retracted && !c.confirmed
        ? h('span', { class: 'tag once', title: 'This page has not been read again since. One observation cannot tell a repositioning from an experiment that is still running.' }, 'seen once')
        : null,
      c.retracted ? h('span', { class: 'tag retracted', title: 'Published in error and withdrawn. It is kept here, struck through, rather than deleted.' }, 'retracted') : null,
      h('time', { datetime: c.detected_at }, fmtDate(c.detected_at)),
    ),
    h('p', { class: 'summary' }, c.summary || `${signalLabel(c.signal)} changed`),
    c.retracted
      ? h('p', { class: 'why' },
          `Retracted ${fmtDate(c.retracted_at)}: ${c.retraction_reason || 'published in error'} `,
          h('a', { href: 'corrections.txt' }, 'Corrections log'))
      : null,
    isText
      ? h('div', { class: 'diff' },
          h('p', { class: 'was' }, h('span', { class: 'marker' }, '− '), c.before_value),
          h('p', { class: 'now' }, h('span', { class: 'marker' }, '+ '), c.after_value),
        )
      : null,
    c.magnitude != null
      ? h('p', { class: 'note', style: 'margin:.5rem 0 0;font-size:.78rem' },
          'change size ',
          h('span', { class: 'magnitude', style: `width:${Math.round(Math.min(1, c.magnitude) * 90) + 4}px` }),
          ` ${Math.round(c.magnitude * 100)}%`,
          c.previous_seen_at ? ` · previous value last seen ${fmtDate(c.previous_seen_at)}` : '')
      : null,
  );
}

async function renderFeed() {
  const list = $('#feed');
  if (!state.changes) {
    try {
      state.changes = (await getJSON(API.changes)).changes;
    } catch (err) {
      list.replaceChildren(h('li', { class: 'empty' }, `Could not load changes: ${err.message}`));
      return;
    }
  }

  // A static file cannot take a query string, so the filter is applied here.
  const shown = state.changes
    .filter((c) => !state.signalFilter || c.signal === state.signalFilter)
    .slice(0, 80);

  if (!shown.length) {
    list.replaceChildren(h('li', { class: 'empty' },
      state.signalFilter
        ? 'No changes recorded for that signal yet.'
        : 'No changes recorded yet. The first sweep establishes a baseline and publishes nothing; ' +
          'differences appear from the second sweep onward.'));
  } else {
    list.replaceChildren(...shown.map(renderChange));
  }

  await renderRetractions();
}

/**
 * Claims this index published and then withdrew.
 *
 * They are excluded from the feed above -- that exclusion is the whole point of
 * a retraction -- and shown here instead, struck through, with the reason. An
 * index that hides its own withdrawn claims is asking to be trusted rather than
 * checked, and this one has already been wrong once in public.
 */
async function renderRetractions() {
  const section = $('#retractions-section');
  const list = $('#retractions');
  if (!state.retracted) {
    try {
      state.retracted = (await getJSON(API.retractions)).retracted || [];
    } catch {
      state.retracted = [];
    }
  }
  const shown = state.retracted.filter((c) => !state.signalFilter || c.signal === state.signalFilter);
  section.hidden = shown.length === 0;
  if (shown.length) list.replaceChildren(...shown.map(renderChange));
}

// --------------------------------------------------------------- companies

async function renderCompanies() {
  const tbody = $('#companies-table tbody');
  let health, companies;
  try {
    [health, companies] = await Promise.all([getJSON(API.health), getJSON(API.companies)]);
  } catch (err) {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, `Could not load: ${err.message}`)));
    return;
  }
  state.health = health.companies;

  const bySlug = new Map(health.companies.map((c) => [c.slug, c]));

  const segSel = $('#segment-filter');
  if (segSel.options.length === 1) {
    for (const seg of [...new Set(companies.companies.map((c) => c.segment))].sort()) {
      segSel.appendChild(h('option', { value: seg }, seg));
    }
  }

  const rows = companies.companies
    .filter((c) => !state.segmentFilter || c.segment === state.segmentFilter)
    .map((c) => {
      const hp = bySlug.get(c.slug) || {};
      return h('tr', {},
        h('td', { class: 'co-name', 'data-label': 'Company' },
          h('a', { href: `#/company/${c.slug}` }, c.name),
          h('span', { class: 'seg' }, c.segment)),
        h('td', { 'data-label': 'Calls itself', class: hp.category ? '' : 'quiet' }, hp.category || '—'),
        h('td', { 'data-label': 'Entry price', class: 'mono' }, hp.entry_price || '—'),
        h('td', { 'data-label': 'Changes', class: 'num' }, fmtNum(hp.total_changes ?? 0)),
        h('td', { 'data-label': 'State' }, h('span', { class: `state ${hp.health || 'pending'}` }, hp.health || 'pending')),
      );
    });

  tbody.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'Nothing matches that filter.'))]));
}

// ------------------------------------------------------------------ health

const HEALTH_MEANING = {
  ok: 'read successfully and every signal is extracting',
  degraded: 'read successfully, but at least one signal is a suspected extraction failure',
  'structure-changed': 'the page parsed but we understood far less of it than before; change detection is paused',
  'origin-shift': 'read successfully, but from a different country or machine than last time; prices and other locale-sensitive signals are recorded and held back rather than published',
  stale: 'no successful read recently',
  error: 'the last attempt failed',
  blocked: 'the site declines automated clients, or robots.txt disallows it',
  pending: 'not attempted yet',
};

async function renderHealth() {
  const tbody = $('#health-table tbody');
  let data;
  try {
    data = await getJSON(API.health);
  } catch (err) {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, `Could not load: ${err.message}`)));
    return;
  }
  state.health = data.companies;

  const counts = {};
  for (const c of data.companies) counts[c.health] = (counts[c.health] || 0) + 1;
  $('#health-legend').replaceChildren(...Object.entries(HEALTH_MEANING)
    .filter(([k]) => counts[k])
    .map(([k, meaning]) => h('li', {},
      h('span', { class: `state ${k}` }, `${k} (${counts[k]})`),
      ' — ', meaning)));

  // Problems first, then healthy, then never-attempted. Someone opening this
  // page is asking "what is broken", so the answer goes at the top.
  const order = ['error', 'stale', 'structure-changed', 'origin-shift', 'degraded', 'blocked', 'ok', 'pending'];
  const sorted = [...data.companies].sort((a, b) => order.indexOf(a.health) - order.indexOf(b.health) || a.name.localeCompare(b.name));

  tbody.replaceChildren(...sorted.map((c) => h('tr', {},
    h('td', { class: 'co-name', 'data-label': 'Company' }, h('a', { href: `#/company/${c.slug}` }, c.name)),
    h('td', { 'data-label': 'State' }, h('span', { class: `state ${c.health}` }, c.health)),
    h('td', { 'data-label': 'Last successful read' }, relative(c.last_ok_at)),
    h('td', { 'data-label': 'Live signals', class: 'num' }, fmtNum(c.live_signals)),
    h('td', { 'data-label': 'Detail', class: 'quiet' }, c.last_reason || '—'),
  )));
}

// ----------------------------------------------------------------- company

async function renderCompany(slug) {
  const root = $('#company-detail');
  root.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));

  let d;
  try {
    d = await getJSON(API.company(slug));
  } catch (err) {
    root.replaceChildren(h('p', { class: 'empty' }, `Could not load ${slug}: ${err.message}`));
    return;
  }

  const c = d.company;
  const lastFetch = d.fetches[0];

  const cards = d.signals
    .slice()
    .sort((a, b) => a.signal.localeCompare(b.signal))
    .map((s) => h('div', { class: `signal-card${s.suspect ? ' suspect' : ''}` },
      h('h4', {}, signalLabel(s.signal)),
      h('div', { class: `val${s.last_good_value ? '' : ' none'}` }, s.last_good_value || 'not currently extracted'),
      h('footer', {},
        s.last_good_method ? `${s.last_good_method} · ` : '',
        `seen ${fmtDate(s.last_good_at)}`,
        s.total_changes ? ` · ${s.total_changes} change${s.total_changes === 1 ? '' : 's'}` : '',
        s.suspect ? h('span', { class: 'flag' }, ' · suspected extraction failure, change detection paused') : '',
      )));

  root.replaceChildren(
    h('div', { class: 'co-header' },
      h('h2', {}, c.name),
      h('p', { class: 'co-meta' },
        h('a', { href: c.homepage_url, rel: 'noopener nofollow', target: '_blank' }, 'homepage'),
        c.pricing_url ? h('a', { href: c.pricing_url, rel: 'noopener nofollow', target: '_blank' }, 'pricing') : null,
        `${c.segment}${c.hq_country ? ' · ' + c.hq_country : ''}`,
        lastFetch ? ` · last read ${relative(lastFetch.fetched_at)} (${lastFetch.status})` : ' · never read',
      ),
      lastFetch && lastFetch.reason
        ? h('p', { class: 'co-meta' }, h('span', { class: `state ${lastFetch.status === 'ok' ? 'ok' : 'error'}` }, lastFetch.status), ' ', lastFetch.reason)
        : null,
    ),
    h('h3', {}, 'Current values'),
    h('div', { class: 'signal-cards' }, cards),
    h('h3', {}, `Timeline (${d.events.length} recorded change${d.events.length === 1 ? '' : 's'})`),
    d.events.length
      ? h('ol', { class: 'timeline' }, d.events.map((e) => h('li', {},
          h('time', { datetime: e.detected_at }, fmtDate(e.detected_at)),
          h('span', { class: `tag ${e.change_type}` }, signalLabel(e.signal)),
          ' ',
          e.confirmed ? null : h('span', { class: 'tag once', title: 'This page has not been read again since.' }, 'seen once'),
          e.confirmed ? '' : ' ',
          e.summary || '',
        )))
      : h('p', { class: 'note' },
          'No changes recorded yet. The first observation of each signal is a baseline, ' +
          'not a change, so a company appears here only once something moves.'),
    h('h3', { style: 'margin-top:2rem' }, 'Recent fetch attempts'),
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'When'), h('th', {}, 'Page'), h('th', {}, 'Status'),
        h('th', { class: 'num' }, 'Signals'), h('th', {}, 'Detail'))),
      h('tbody', {}, d.fetches.map((f) => h('tr', {},
        h('td', { 'data-label': 'When' }, fmtDate(f.fetched_at)),
        h('td', { 'data-label': 'Page' }, f.kind),
        h('td', { 'data-label': 'Status' }, h('span', { class: `state ${f.status === 'ok' || f.status === 'unchanged' ? 'ok' : f.status === 'blocked' ? 'blocked' : 'error'}` }, f.status)),
        h('td', { 'data-label': 'Signals', class: 'num' }, `${f.signals_found}/${f.signals_expected}`),
        h('td', { 'data-label': 'Detail', class: 'quiet' }, f.reason || `HTTP ${f.http_status ?? '—'}`),
      )))),
  );
}

// ------------------------------------------------------------------ router

const VIEWS = ['positioning', 'feed', 'companies', 'health', 'company'];

function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  for (const a of $$('.tabs a')) a.classList.toggle('on', a.dataset.tab === view);
}

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);

  if (parts[0] === 'company' && parts[1]) {
    show('company');
    await renderCompany(parts[1]);
    return;
  }
  if (parts[0] === 'companies') { show('companies'); await renderCompanies(); return; }
  // `#/categories` was its own tab before the landing view existed. It is now a
  // section of the front page, and the old link still lands on it.
  if (parts[0] === 'categories') { location.replace('#/'); return; }
  if (parts[0] === 'changes') { show('feed'); await renderFeed(); return; }
  if (parts[0] === 'health') { show('health'); await renderHealth(); return; }

  // The landing view is already in the document. Showing it is all there is
  // to do, and it is what an unrecognised route falls back to.
  show('positioning');
}

// A route is a hash that starts with a slash. Anything else is an in-page
// anchor into a section of the landing view, and scrolling those back to the
// top would defeat the link.
window.addEventListener('hashchange', () => {
  route();
  if (location.hash.startsWith('#/') || location.hash === '') window.scrollTo(0, 0);
});

$('#signal-filter').addEventListener('change', (e) => { state.signalFilter = e.target.value; renderFeed(); });
$('#segment-filter').addEventListener('change', (e) => { state.segmentFilter = e.target.value; renderCompanies(); });

loadStats().catch((err) => {
  const banner = $('#crawl-banner');
  banner.textContent = `The index API is not responding (${err.message}). Nothing below can be trusted.`;
  banner.hidden = false;
}).finally(route);

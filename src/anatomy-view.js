/**
 * The page-anatomy view, rendered to a string at build time.
 *
 * Same contract as landing.js: the findings are in index.html before a line of
 * JavaScript runs, and the script only adds interaction. With scripting off you
 * still get every number, every strip and every company behind every bar.
 *
 * ON THE COPY
 * -----------
 * Generated from the numbers, never typed next to them. A sentence that would
 * stop being true at a different value is a sentence this file cannot write.
 *
 * ONE THING IS SAID BEFORE ANYTHING ELSE
 * --------------------------------------
 * Every other view in this project reports values read off a page. This one
 * reports a classification of a span of markup, which is an opinion. The
 * classifier's `other` rate leads the view rather than sitting in a footnote,
 * because a reader who does not know how much of this is guesswork cannot
 * calibrate anything below it.
 */

import { barChart, companyLink, coverageNote, detailsTable, escapeHtml, shareBars } from './charts.js';
import { renderWireframe, sectionLabel } from './anatomy-svg.js';
import { pageInsight, sectionInsight } from './anatomy-compare.js';

// One label map for the whole view, imported rather than repeated: anatomy-svg.js
// owns it and asserts at import that every SECTION_TYPES member has one, so a new
// classifier type breaks the build instead of printing its raw key into docs/.
// This file previously carried its own copy covering only 12 of the 17 types.
const label = sectionLabel;

/**
 * A JSON island, safe to embed in HTML.
 *
 * The only sequence that can end a script element early is `</script`, so that
 * is the only thing that has to be broken up. Escaping the whole payload with
 * escapeHtml would corrupt it, because the browser does not entity-decode the
 * contents of a script element -- JSON.parse would then see `&quot;` and throw,
 * and by design that leaves the figure permanently inert.
 */
function jsonIsland(data, className) {
  const text = JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1');
  return `<script type="application/json" class="${className}">${text}</script>`;
}

/**
 * One company as an interactive wireframe: the page's shape, with an insight
 * panel beside it.
 *
 * This replaces the flat strip that used to live here. It is the same
 * information -- the ordered sequence of sections -- but a block whose height
 * carries how much of the page it occupies says something the strip could not,
 * and a panel that can hold the corpus comparison is what makes a section
 * clickable rather than merely coloured.
 *
 * Everything is written here at build time. app.js attaches behaviour to what
 * is already on screen and renders nothing that is not already readable with
 * scripting switched off, which is the same contract the landing view keeps.
 *
 * `maxWords` is the PAGE's own longest section, deliberately not the corpus
 * maximum. Scaled against the corpus, one 23,000-word outlier would flatten
 * every other page in the set to the minimum block height and all 180
 * wireframes would come out as identical uniform stacks.
 */
function wireframe(company, anatomy, accuracy) {
  const secs = company.sections ?? [];
  const maxWords = secs.reduce((m, x) => Math.max(m, x.words ?? 0), 0) || 1;

  // The island carries what the panel renders and nothing else.
  //
  // The full insight object is 13kB per section, and 8kB of that is the ranking
  // of every type at that position with its company list -- corpus-wide data,
  // identical for every company at the same position, repeated 1,248 times. It
  // built a 15MB index.html that gzipped to 1.2MB, against 92kB for the page
  // this replaces. So the corpus payload is dropped and the sentence derived
  // from it is kept.
  //
  // The caveat and accuracy block ARE repeated per section, deliberately: they
  // are byte-identical everywhere, so compression reduces them to nothing, and
  // the alternative is a panel that can render a judged claim with no caveat
  // attached if a lookup ever misses.
  const island = {};
  for (const sec of secs) {
    const full = sectionInsight({ section: sec, company, anatomy, accuracy });
    island[String(sec.position)] = {
      position: full.position,
      type: full.type,
      typeLabel: full.typeLabel,
      heading: full.heading,
      words: full.words,
      measured: (full.measured ?? []).map((m) => ({
        label: m.label, value: m.value, unit: m.unit, comparison: m.comparison,
      })),
      judged: (full.judged ?? []).map((j) => ({
        label: j.label, value: j.value, n: j.n, of: j.of, share: j.share,
      })),
      // Peers keep their names: the panel links to them, and a slug is not a
      // label a reader can use. Capped by anatomy-compare's PEER_LIMIT, which
      // reports how many it omitted rather than presenting a short list as whole.
      peers: full.peers,
      caveat: full.caveat,
      // `accuracy` is a nested object repeated on every section. The caveat
      // sentence already states the figure, api/anatomy.json publishes the
      // block once, and dropping it here is ~600kB of parse the browser does
      // not have to do.
      notes: full.notes?.length ? full.notes : undefined,
    };
  }

  const page = pageInsight({ company, anatomy, accuracy });
  const pageLine = page.measured
    .map((m) => m.comparison)
    .filter(Boolean)
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('');

  return `
    <figure class="wf-figure" data-slug="${escapeHtml(company.slug)}">
      <figcaption class="wf-cap">
        ${companyLink(company)}
        <span class="wf-cap-meta">${secs.length ? `${secs.length} sections` : 'no readable sequence'}</span>
      </figcaption>
      ${renderWireframe({ slug: company.slug, name: company.name, sections: secs, maxWords })}
      <div class="wf-panel" role="region" aria-live="polite" tabindex="-1">
        <p class="wf-empty">Hover, tap or focus a block to see how that section compares.</p>
      </div>
      ${pageLine ? `<ul class="wf-page">${pageLine}</ul>` : ''}
      ${jsonIsland(island, 'wf-data')}
    </figure>`;
}

/** A position column: what sits at slot N across the corpus. */
function positionBlock(p) {
  return `
    <section class="pos">
      <h3>Position ${p.position}</h3>
      ${barChart({
        rows: p.types.map((t) => ({ label: label(t.type), n: t.n, note: `${t.share}% of ${p.n}` })),
        unit: 'companies',
      })}
      <p class="note">Counted over ${p.n} companies whose sequence reaches this position.</p>
      ${detailsTable({
        summary: 'Which companies',
        columns: [
          { label: 'Section', get: (t) => escapeHtml(label(t.type)) },
          { label: 'Companies', get: (t) => t.companies.map(companyLink).join(', ') },
        ],
        rows: p.types,
      })}
    </section>`;
}

function scaleRow(s) {
  if (!s.n) return '';
  return `
    <tr>
      <th scope="row">${escapeHtml(s.label)}</th>
      <td>${s.min}</td><td>${s.p25}</td><td><b>${s.median}</b></td><td>${s.p75}</td><td>${s.max}</td>
      <td>${s.coverage.readable} of ${s.coverage.tracked}</td>
    </tr>`;
}

export function renderAnatomy(a, accuracy = undefined) {
  const q = a.quality;
  const readable = a.positions.coverage;

  const quality = `
    <section class="callout" id="anatomy-quality">
      <h3>How much of this is a judgement</h3>
      <p>
        Across ${readable.readable} readable pages the classifier named
        <b>${q.named} of ${q.sections}</b> sections and left
        <b>${q.other}</b> as <i>unclassified</i>${q.other_share === null ? '' : ` — ${q.other_share}%`}.
      </p>
      <p class="note">${escapeHtml(q.note)}</p>
      ${q.companies_with_other.length ? detailsTable({
        summary: `The ${q.companies_with_other.length} pages with the most unclassified sections`,
        columns: [
          { label: 'Company', get: (r) => companyLink(r) },
          { label: 'Unclassified', get: (r) => String(r.other) },
          { label: 'Sections', get: (r) => String(r.of) },
        ],
        rows: q.companies_with_other,
      }) : ''}
    </section>`;

  const definition = `
    <section class="callout">
      <h3>What counts as a section</h3>
      <p>
        The span of markup from one <code>&lt;h2&gt;</code> to the next. The hero is everything
        before the first one. That is the whole definition, and it is the definition because it
        needs only the document: a rule about visually distinct bands would need a browser, and a
        rule about class names would break every time somebody refactors their CSS.
      </p>
      <p class="note">
        It is wrong in two known ways. A page whose bands are headed by <code>&lt;h3&gt;</code> or by
        styled <code>&lt;div&gt;</code>s has no readable sequence at all, and is reported as
        unreadable rather than as a single enormous hero — ${readable.unreadable} of
        ${readable.tracked} pages are in that state. A page that heads every feature with its own
        <code>&lt;h2&gt;</code> over-counts, so a run of identical adjacent types is collapsed to one.
      </p>
    </section>`;

  const elements = `
    <section>
      <h2>What a page carries</h2>
      <p>Whether each kind of section appears at all, in any position.</p>
      ${shareBars({
        rows: a.elements.elements.map((e) => ({
          label: label(e.type),
          part: e.n,
          whole: e.of,
          of: e.of,
        })),
        unit: 'companies',
      })}
      ${detailsTable({
        summary: 'Which companies carry each',
        columns: [
          { label: 'Section', get: (e) => escapeHtml(label(e.type)) },
          { label: 'Companies', get: (e) => e.companies.map(companyLink).join(', ') },
        ],
        rows: a.elements.elements,
      })}
      ${coverageNote(a.elements.coverage, { unit: 'companies', reason: 'pages with no readable section sequence' })}
    </section>`;

  const positions = `
    <section>
      <h2>What sits where</h2>
      <p>
        The order a page puts things in. Position one is the hero on essentially every page;
        the interesting question is what a market does with position two.
      </p>
      <div class="pos-grid">${a.positions.positions.map(positionBlock).join('')}</div>
    </section>`;

  const scales = `
    <section>
      <h2>How big a page is</h2>
      <table class="scales">
        <thead><tr>
          <th scope="col">Measure</th><th scope="col">min</th><th scope="col">p25</th>
          <th scope="col">median</th><th scope="col">p75</th><th scope="col">max</th>
          <th scope="col">readable</th>
        </tr></thead>
        <tbody>${a.scales.scales.map(scaleRow).join('')}</tbody>
      </table>
      ${detailsTable({
        summary: 'The extremes, in both directions',
        columns: [
          { label: 'Measure', get: (x) => escapeHtml(x.label) },
          { label: 'Fewest', get: (x) => x.extremes.lowest.map((e) => `${companyLink(e)} ${e.value}`).join(', ') },
          { label: 'Most', get: (x) => x.extremes.highest.map((e) => `${companyLink(e)} ${e.value}`).join(', ') },
        ],
        rows: a.scales.scales.filter((x) => x.n),
      })}
    </section>`;

  const filters = `
    <section id="anatomy-strips">
      <h2>Every page, in order</h2>
      <p>
        One row per company, left to right in the order the sections appear. Hover a block for its
        heading and length. Everything below is in the page already; the controls only filter it.
      </p>
      <div class="filters" id="anatomy-filters" hidden>
        <label>Contains
          <select id="f-type">
            <option value="">any section</option>
            ${a.vocabulary.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(label(t))}</option>`).join('')}
          </select>
        </label>
        <label>Search <input type="search" id="f-q" placeholder="company name"></label>
        <span class="filter-count" id="f-count"></span>
      </div>
      <div class="wf-gallery" id="strips">${a.companies.map((c) => wireframe(c, a, accuracy)).join('')}</div>
    </section>`;

  return [quality, definition, positions, elements, scales, filters].join('\n');
}

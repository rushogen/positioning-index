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

  // The explorer is a client-side app, and the split is deliberate.
  //
  // Everything above this point is a FINDING -- a distribution computed from the
  // corpus -- and findings are written into the document at build time, because
  // a page that says nothing until a JSON file arrives is a page that says
  // nothing. Below it is a TOOL for looking at one company at a time, which is
  // a different kind of thing: it needs to re-render on every selection, and
  // inlining all 200 of them cost 3.5MB of markup to show one at a time.
  //
  // The no-script fallback is not an apology. It names the API file, which is
  // the same data the app reads, so a reader without JavaScript is one fetch
  // away from everything the tool would have shown them.
  const map = `
    <section id="anatomy-map-section">
      <h2>Which pages are shaped alike</h2>
      <p>
        Every readable page as a dot, pulled towards the six pages whose section
        sequence is closest to its own. Similarity is normalised edit distance over
        the ordered list of section types, computed when the site is built and
        published in the API, so the arrangement can be checked rather than taken.
      </p>
      <div class="wf-map-wrap">
        <div id="wf-map" data-src="api/anatomy.json">
          <noscript>
            <p class="wf-noscript">
              The map needs JavaScript. The distances behind it do not: every page's
              closest neighbours are in
              <a href="api/anatomy.json"><code>api/anatomy.json</code></a> under
              <code>similarity</code>.
            </p>
          </noscript>
        </div>
        <div id="wf-map-panel" class="wf-panel" role="region" aria-live="polite"></div>
      </div>
      <p class="note">
        Position is a readable arrangement of a graph, not a projection with axes.
        Read the clusters, not the pixels; the distances are in the panel, and most
        of them are high.
      </p>
    </section>`;

  const explorer = `
    <section id="anatomy-explorer">
      <h2>Look at one page</h2>
      <p>
        Each block is a section, its height showing how much of the page it takes up.
        Pick a company, then hover, tap or focus a block to see what that section is
        and how it compares to the other ${readable.readable} readable pages.
      </p>
      <div id="wf-app" data-src="api/anatomy.json">
        <noscript>
          <p class="wf-noscript">
            The explorer needs JavaScript. The findings above do not, and neither does
            the data behind it: every company's section sequence is in
            <a href="api/anatomy.json"><code>api/anatomy.json</code></a>.
          </p>
        </noscript>
      </div>
    </section>`;

  return [quality, definition, map, explorer, positions, elements, scales].join('\n');
}

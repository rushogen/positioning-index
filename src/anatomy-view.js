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

/** Human labels for the section vocabulary. The keys are the published values. */
const LABEL = {
  hero: 'Hero',
  logos: 'Logo wall',
  proof: 'Proof / numbers',
  testimonial: 'Testimonial',
  pricing: 'Pricing block',
  faq: 'FAQ',
  comparison: 'Comparison table',
  integrations: 'Integrations',
  features: 'Feature grid',
  cta: 'Call to action',
  media: 'Video / media',
  other: 'Unclassified',
};

const label = (t) => LABEL[t] ?? t;

/** One company's sequence as a row of labelled blocks. */
function strip(company) {
  if (!company.sections) {
    return `<p class="strip-none">No readable section sequence. `
      + `The page's bands are not <code>&lt;h2&gt;</code>-headed, so this is an extraction gap `
      + `rather than a page without structure.</p>`;
  }
  const blocks = company.sections
    .map((s) => {
      const title = s.heading ? `${label(s.type)} — ${s.heading}` : label(s.type);
      return `<span class="blk blk-${escapeHtml(s.type)}" title="${escapeHtml(title)} (${s.words} words)">`
        + `<span class="blk-n">${s.position}</span>`
        + `<span class="blk-t">${escapeHtml(label(s.type))}</span>`
        + `</span>`;
    })
    .join('');
  return `<div class="strip" role="list" aria-label="Section sequence">${blocks}</div>`;
}

/**
 * The strip list, one row per company.
 *
 * Rendered in full. The script adds filtering on top; it does not fetch this,
 * because a view that says nothing until a JSON file arrives is a view that
 * says nothing to anyone reading with scripting off.
 */
function strips(companies) {
  const rows = companies.map((c) => `
    <li class="strip-row" data-slug="${escapeHtml(c.slug)}" data-segment="${escapeHtml(c.segment ?? '')}"
        data-types="${escapeHtml((c.sections ?? []).map((s) => s.type).join(' '))}">
      <div class="strip-head">
        ${companyLink(c)}
        <span class="strip-meta">${
          c.sections
            ? `${c.sections.length} sections${c.words != null ? ` · ${c.words} words` : ''}`
              + `${c.nav_links != null ? ` · nav ${c.nav_links}` : ''}`
              + `${c.footer_links != null ? ` · footer ${c.footer_links}` : ''}`
            : 'not readable'
        }</span>
      </div>
      ${strip(c)}
    </li>`).join('');
  return `<ol class="strips" id="strips">${rows}</ol>`;
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

export function renderAnatomy(a) {
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
      ${strips(a.companies)}
    </section>`;

  return [quality, definition, positions, elements, scales, filters].join('\n');
}

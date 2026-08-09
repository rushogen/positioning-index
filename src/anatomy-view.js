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
 * classifier is right about half the time off the hero, so nearly every finding
 * here carries a `judged` chip stating that rate, and the `other` rate leads the
 * quality block rather than sitting in a footnote -- a reader who does not know
 * how much of this is guesswork cannot calibrate anything below it.
 *
 * STAT-LED
 * --------
 * Each block is a finding(): the number is read before the sentence and the
 * sentence before the chart. The multi-paragraph prose that used to introduce
 * each chart is compressed to one caption plus chips; the method and the tables
 * of companies behind every mark are unchanged, collapsed in <details>, because
 * compressing the DISPLAY of the honesty must not delete the honesty.
 */

import { companyLink, detailsTable, escapeHtml, finding } from './charts.js';
import { sectionLabel } from './anatomy-svg.js';
import { accuracyBlock } from './anatomy-compare.js';
import { archetype } from './anatomy-archetype.js';
import { renderArchetypeMock } from './archetype-mock.js';

// One label map for the whole view, imported rather than repeated: anatomy-svg.js
// owns it and asserts at import that every SECTION_TYPES member has one, so a new
// classifier type breaks the build instead of printing its raw key into docs/.
// This file previously carried its own copy covering only 12 of the 17 types.
const label = sectionLabel;

/**
 * The chip that rides every stat resting on the section classifier.
 *
 * The chapter's honesty anchor. Almost everything here is a classification of a
 * span of markup, not a value read off the page, and the classifier agrees with
 * the human label only about half the time off the hero. The rate is derived
 * from the measured accuracy passed into the view -- never typed -- so the chip
 * cannot claim 49% on a morning the classifier scores 34%. With no score to hand
 * it falls back to the approximate wording the rest of the copy uses.
 */
function judgedChip(accuracy) {
  const nonHero = accuracy ? accuracyBlock(accuracy).nonHero : null;
  const text = nonHero
    ? `classifier ${Math.round(nonHero * 100)}% off-hero`
    : 'classifier ~49% off-hero';
  return { label: text, tone: 'judged' };
}

/**
 * The archetype: the market's homepage as one composite diagram.
 *
 * A finding, so it is written here at build time and readable with no script.
 * The lead number is the count of pages composited into it; the caption says in
 * one line that it is a composite and that each band's absence is stated beside
 * its presence. The mock IS the chart. Each band is a section type at its typical
 * position, its fill how many pages carry it, and the real headings sit behind a
 * <details> inside the mock, which is the whole of the interaction and needs no
 * JS.
 */
function renderArchetype(a, accuracy) {
  const arch = archetype(a);

  return finding({
    id: 'anatomy-archetype',
    stat: { figure: arch.readable_pages, unit: 'readable homepages, composited into one' },
    heading: 'The archetype homepage',
    caption:
      'A composite no company publishes: every section type placed where it typically appears and '
      + 'sized by how many of these pages carry it, with the share that leaves each band out stated '
      + 'beside the share that keeps it.',
    chips: [judgedChip(accuracy)],
    chart: renderArchetypeMock(a),
  });
}

export function renderAnatomy(a, accuracy = undefined, clusters = null) {
  const q = a.quality;
  const readable = a.positions.coverage;
  const chip = judgedChip(accuracy);

  // The honesty section. It leads with the share of sections the classifier could
  // not name -- the one figure that says how far to trust everything below it --
  // and keeps the note as method and the worst-offender pages as the inspect
  // table. Guarded because `other_share` is null when nothing was readable.
  const quality = finding({
    id: 'anatomy-quality',
    stat: q.other_share === null ? undefined : { figure: `${q.other_share}%`, unit: 'of sections the classifier could not name' },
    heading: 'How much of this is a judgement',
    caption:
      `Across <b>${readable.readable}</b> readable pages the classifier named `
      + `<b>${q.named} of ${q.sections}</b> sections and left <b>${q.other}</b> unclassified.`,
    chips: [chip],
    method: escapeHtml(q.note),
    inspect: q.companies_with_other.length ? detailsTable({
      summary: `The ${q.companies_with_other.length} pages with the most unclassified sections`,
      columns: [
        { label: 'Company', get: (r) => companyLink(r) },
        { label: 'Unclassified', get: (r) => String(r.other) },
        { label: 'Sections', get: (r) => String(r.of) },
      ],
      rows: q.companies_with_other,
    }) : '',
  });

  // "Which pages are shaped alike" is shown twice from one set of distances: a
  // WebGL point cloud (mounted at #wf-globe, driven by anatomy-globe.js) above,
  // coloured by shape family and labelled per lobe, and the flat, keyboard-
  // navigable map (#wf-map, owned by anatomy-map.js) below. The globe hides
  // .wf-globe-stage when WebGL is unavailable, so the flat map is the fallback.
  // The lead stat is how many recurring families exist; the caption names the
  // near-unique majority, so the diagram does not oversell its own clustering.
  const map = finding({
    id: 'anatomy-map-section',
    stat: clusters ? { figure: clusters.clusters.length, unit: `recurring shape families among the ${clusters.of} readable pages` } : undefined,
    heading: 'Which pages are shaped alike',
    caption: clusters
      ? `Most pages are structurally near-unique: only <b>${clusters.clustered} of ${clusters.of}</b> fall into `
        + `<b>${clusters.clusters.length}</b> recurring shapes, the coloured, labelled lobes in the cloud; the `
        + `other <b>${clusters.near_unique}</b> sit on their own. Drag to explore, or read the flat, `
        + `keyboard-first map below — both are the same published distances.`
      : 'Every readable page as a point, pulled towards the pages whose section sequence is closest to its '
        + 'own, coloured by shape family — shown in 3D and, below, as a flat keyboard-navigable map.',
    chips: [chip],
    chart: `
      <div class="wf-globe-stage">
        <div id="wf-globe" class="wf-globe" data-src="api/anatomy.json" tabindex="0" role="img"
             aria-label="A three-dimensional point cloud of the readable pages, arranged so structurally similar pages sit near each other. Drag to rotate; hover or focus a company for its closest shapes. The same graph is in the flat, keyboard-navigable map below.">
          <p class="wf-globe-hint" aria-hidden="true">Drag to rotate &middot; hover a company</p>
        </div>
        <div id="wf-globe-panel" class="wf-panel" role="region" aria-live="polite"></div>
      </div>
      <h4 class="sub-chart-head">The same graph, flat and keyboard-first</h4>
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
      </div>`,
    extra: `
      <p class="note">
        Position is a readable arrangement of a graph, not a projection with axes.
        Read the families, not the pixels; the exact edit distances are in the panel.
      </p>`,
    method:
      'Similarity is normalised edit distance over the ordered list of section types, computed when the '
      + 'site is built and published in the API, so the arrangement can be checked rather than taken.',
  });

  // Stripped to the spine: the archetype, the honesty block, and the shape map
  // (3D + flat). The secondary structure findings (what counts as a section, what
  // a page carries, what sits where, how big a page is) and the per-page explorer
  // were cut in the declutter; they remain in git history and api/anatomy.json.
  return [renderArchetype(a, accuracy), quality, map].join('\n');
}

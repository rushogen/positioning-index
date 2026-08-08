/**
 * The archetype landing page, drawn AS a page.
 *
 * The archetype model gives, per section type, how many pages carry it, where it
 * typically sits, and how big it is. This renders that as a mockup a reader
 * recognises: a hero with a headline and a button, a logo strip, a feature
 * grid, a proof row, a testimonial card, pricing columns, a call to action.
 * Each block is built from the aggregate and, on interaction, tells you the
 * specific finding and who breaks the convention.
 *
 * PROGRESSIVE ENHANCEMENT, THE PROJECT'S RULE
 * -------------------------------------------
 * The insight for every block is written into a visible list below the mock, so
 * with scripting off a reader still gets all of it -- each block is an anchor
 * that jumps to its entry. public/archetype-mock.js upgrades that to an in-place
 * panel and prevents the jump. Nothing is hidden behind JS.
 *
 * NOT A PRESCRIPTION
 * ------------------
 * It looks like one page and is a composite of 180. It measures what the market
 * did, not what works, and every block states who leaves it out as plainly as
 * how many keep it. The section types are the classifier's, so the caveat rides
 * along.
 */

import { archetype } from './anatomy-archetype.js';
import { escapeHtml, companyLink } from './charts.js';
import { sectionLabel } from './anatomy-svg.js';

const ORDINAL = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n) => (Number.isInteger(n) && n >= 0 && n < ORDINAL.length ? ORDINAL[n] : `${n}th`);

/**
 * A recognisable skin per section type: a few inert shapes that read as that
 * kind of block at a glance. Pure decoration, aria-hidden -- the meaning is in
 * the label and the insight, never in the picture.
 */
function skin(type) {
  const bars = (n, ws) => ws.slice(0, n).map((w) => `<span class="mk-bar" style="width:${w}%"></span>`).join('');
  const chips = (n, cls = 'mk-chip') => Array.from({ length: n }, () => `<span class="${cls}"></span>`).join('');
  const cards = (n) => Array.from({ length: n }, () => '<span class="mk-card"><span class="mk-card-ic"></span><span class="mk-bar" style="width:70%"></span><span class="mk-bar" style="width:90%"></span></span>').join('');
  switch (type) {
    case 'hero':        return `<div class="mk-skin mk-hero">${bars(2, [72, 52])}<span class="mk-btn"></span></div>`;
    case 'logos':       return `<div class="mk-skin mk-row">${chips(5)}</div>`;
    case 'integrations':return `<div class="mk-skin mk-row">${chips(6, 'mk-chip mk-chip-sq')}</div>`;
    case 'features':    return `<div class="mk-skin mk-grid">${cards(3)}</div>`;
    case 'product':     return `<div class="mk-skin mk-split"><span class="mk-panel-shape"></span><span class="mk-lines">${bars(3, [90, 80, 60])}</span></div>`;
    case 'proof':       return `<div class="mk-skin mk-stats"><span class="mk-stat">10x</span><span class="mk-stat">20k</span><span class="mk-stat">99%</span></div>`;
    case 'testimonial': return `<div class="mk-skin mk-quote"><span class="mk-qmark">&ldquo;</span>${bars(2, [88, 66])}<span class="mk-attr"></span></div>`;
    case 'pricing':     return `<div class="mk-skin mk-cols"><span class="mk-col"></span><span class="mk-col mk-col-hi"></span><span class="mk-col"></span></div>`;
    case 'security':    return `<div class="mk-skin mk-row">${chips(4, 'mk-badge')}</div>`;
    case 'resources':   return `<div class="mk-skin mk-grid">${cards(3)}</div>`;
    case 'faq':         return `<div class="mk-skin mk-faq"><span class="mk-qline"></span><span class="mk-qline"></span><span class="mk-qline"></span></div>`;
    case 'cta':         return `<div class="mk-skin mk-cta"><span class="mk-bar" style="width:40%"></span><span class="mk-btn"></span></div>`;
    default:            return `<div class="mk-skin mk-row">${bars(1, [60])}</div>`;
  }
}

/** A generated, descriptive line for a section -- from the numbers, so it can't drift. */
function insightLine(b) {
  const pctv = Math.round(b.share * 100);
  const where = b.median_position ? `Usually the ${ordinal(b.median_position)} section on the page` : 'Position varies';
  let strength;
  if (pctv >= 90) strength = 'On essentially every page.';
  else if (pctv >= 66) strength = 'On most pages.';
  else if (pctv >= 45) strength = 'On roughly half.';
  else if (pctv >= 30) strength = 'On a large minority.';
  else strength = 'On a minority of pages.';
  return `${strength} ${where}, running about ${b.median_words} words.`;
}

/**
 * "Who breaks it" for a convention (a majority section) is who omits it; for a
 * minority choice, the interesting names are the ones who make it. Either way it
 * is divergence from the majority, and it always says how many are not listed.
 */
function breakers(b) {
  const majority = b.share >= 0.5;
  const list = majority ? b.absent_examples : b.carrier_examples;
  const omitted = majority ? b.absent_omitted : Math.max(0, b.carriers - (b.carrier_examples?.length ?? 0));
  if (!list || !list.length) return null;
  const names = list.map(companyLink).join(', ');
  const more = omitted > 0 ? ` <span class="mk-more">and ${omitted} more</span>` : '';
  const label = majority
    ? `Ships without it (${b.absent} of ${b.of})`
    : `Among the ${b.carriers} that use it`;
  return { label, html: names + more };
}

export function renderArchetypeMock(anatomy) {
  const arch = archetype(anatomy);
  const pct = (x) => Math.round(x * 100);

  const blocks = arch.bands.map((b) => `
    <a class="mk-sec mk-t-${escapeHtml(b.type)}" href="#mk-i-${escapeHtml(b.type)}"
       data-type="${escapeHtml(b.type)}"
       aria-label="${escapeHtml(sectionLabel(b.type))}: on ${pct(b.share)} percent of pages. Show the detail.">
      ${skin(b.type)}
      <span class="mk-tag">
        <span class="mk-name">${escapeHtml(sectionLabel(b.type))}</span>
        <span class="mk-share">${pct(b.share)}%</span>
      </span>
    </a>`).join('');

  const cards = arch.bands.map((b) => {
    const brk = breakers(b);
    return `
      <div class="mk-insight" id="mk-i-${escapeHtml(b.type)}" data-type="${escapeHtml(b.type)}">
        <h3>${escapeHtml(sectionLabel(b.type))}</h3>
        <p class="mk-headline"><b>${pct(b.share)}%</b> of ${b.of} pages carry it &middot; <b>${b.absent}</b> do not</p>
        <p class="mk-line">${escapeHtml(insightLine(b))}</p>
        ${brk ? `<p class="mk-breaks"><span class="mk-breaks-label">${escapeHtml(brk.label)}</span> ${brk.html}</p>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="mk" id="anatomy-mock">
      <div class="mk-stage">
        <div class="mk-page" role="list" aria-label="The archetypal landing page, top to bottom">
          <div class="mk-chrome" aria-hidden="true"><span></span><span></span><span></span></div>
          ${blocks}
        </div>
        <aside class="mk-panel" id="mk-panel" aria-live="polite" hidden></aside>
      </div>
      <div class="mk-insights" id="mk-insights">
        <p class="note">One entry per section. Selecting a block above brings its detail here; with scripting off, each block jumps to its entry in this list.</p>
        ${cards}
      </div>
      <p class="wf-caveat">${escapeHtml(arch.caveat)}</p>
    </div>`;
}

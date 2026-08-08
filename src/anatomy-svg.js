/**
 * One company's page shape, drawn as a wireframe, as a string, at build time.
 *
 * anatomy-view.js already renders the section sequence as a horizontal strip of
 * coloured chips. That strip answers "what is on this page and in what order".
 * It cannot answer "what does this page feel like to scroll", because it throws
 * away the one dimension the reader actually experiences: length. A hero of 808
 * words and a logo strip of 12 are the same chip in a strip, and they are not
 * remotely the same band on the page.
 *
 * So this file draws the other view. One vertical stack per company, one block
 * per section, top to bottom in the order the sections appear, with block height
 * standing in for how much of the page that section takes up. It is a wireframe
 * in the ordinary sense: the shape of the page with the words removed.
 *
 * WHY THIS ONE HAS A viewBox WHEN THE CHARTS DO NOT
 * -------------------------------------------------
 * charts.js explains at length why its bars have no viewBox: they contain text
 * at a fixed pixel size, and a viewBox would scale that text down to nothing on
 * a phone. The header of that file is right about charts and does not apply
 * here, for one reason -- this drawing is a *shape*. Its whole content is the
 * relative height of one block against another, and that relationship survives
 * being scaled. So it gets `viewBox="0 0 320 H"` with `width="100%"` and
 * `height="auto"`, which makes it fluid in a column of any width without a
 * single media query, and it never gets a pixel width, because a wireframe that
 * does not fit its column is a wireframe nobody sees the bottom of.
 *
 * The text inside it does scale with everything else, which is the cost. It is
 * affordable here and only here, because no meaning is carried by the visible
 * text alone: every block states its own type in its `aria-label`, and the same
 * sequence is in the strip and in the table on the same page. If the label
 * shrinks past legibility on a narrow column the drawing is still a drawing, and
 * the facts are still readable somewhere that is not a drawing.
 *
 * WHY THE HEIGHTS ARE CLAMPED
 * ---------------------------
 * Strictly proportional height is unusable on this corpus. `anatomy_word_count`
 * runs from a few dozen words to more than twenty thousand, and one page in the
 * set has a single 1,887-word band. Drawn to true scale that page is several
 * thousand units tall, every other page collapses to a hairline, and the reader
 * learns one fact (a page is long) at the cost of the fact the drawing exists to
 * show (what its bands are). So a block is proportional between MIN_BLOCK_HEIGHT
 * and MAX_BLOCK_HEIGHT and flat outside them. That is a lie about the outlier
 * and it is a deliberate one: the caller prints the real word counts as text
 * beside this, and the shape is what the picture is for.
 *
 * COLOUR IS NOT IN THIS FILE
 * --------------------------
 * Not one fill, stroke or colour value appears below. Every block carries
 * `wf-t-{type}` and the palette lives in public/style.css with the rest of the
 * theme, so light and dark are handled once, in the place that already handles
 * them. This file emits geometry and text; the stylesheet decides what it looks
 * like.
 *
 * ACCESSIBILITY IS NOT DECORATION HERE
 * ------------------------------------
 * Three rules, all of them load-bearing rather than a checklist:
 *
 *   Colour never carries meaning on its own. `wf-t-features` and `wf-t-proof`
 *   may be two tones of the same hue for all this file knows, so the type name
 *   is always in the block's `aria-label`, and normally in visible text too.
 *
 *   Every block is `tabindex="0"` and `role="button"`, in document order, which
 *   is section order, which is the order they are drawn. A keyboard reaches them
 *   top to bottom exactly as an eye does.
 *
 *   Nothing is hover-only. The `aria-label` is a whole sentence -- position,
 *   type, heading, length -- so a screen reader gets what a mouse pointer would
 *   have revealed, without the pointer.
 *
 * DETERMINISM
 * -----------
 * Byte-identical output for identical input, like everything else that lands in
 * docs/. Sections are sorted by position rather than trusted to arrive in order,
 * every coordinate is an integer, and nothing here reads a clock or a hash seed.
 */

import { escapeHtml } from './charts.js';
import { SECTION_TYPES } from './extract/anatomy.js';

/**
 * Human labels for the section vocabulary, keyed by the published type value.
 *
 * Exported because more than one view names these types and they must not drift
 * apart: a reader who sees "Proof / numbers" in the strip and "Proof" in the
 * wireframe has to work out whether they are the same thing. The twelve labels
 * that anatomy-view.js already publishes are reproduced exactly, and the five it
 * never had a label for are added here. Every member of SECTION_TYPES has an
 * entry, and there is a test that fails if a new type is added without one.
 */
export const SECTION_LABEL = {
  hero: 'Hero',
  logos: 'Logo wall',
  proof: 'Proof / numbers',
  testimonial: 'Testimonial',
  pricing: 'Pricing block',
  faq: 'FAQ',
  comparison: 'Comparison table',
  integrations: 'Integrations',
  features: 'Feature grid',
  product: 'Product overview',
  resources: 'Resources',
  awards: 'Awards / analysts',
  events: 'Events',
  security: 'Security / compliance',
  cta: 'Call to action',
  media: 'Video / media',
  other: 'Unclassified',
};

/**
 * The label for a type, falling back to the raw key.
 *
 * A type this file has never heard of is a real possibility -- the classifier's
 * vocabulary is allowed to grow, and a build must not crash or print `undefined`
 * because it grew. Printing the key is honest: it is what the data says.
 */
export function sectionLabel(type) {
  return SECTION_LABEL[type] ?? String(type ?? 'other');
}

/** The coordinate space. Never a pixel width; see the header. */
export const WIREFRAME_WIDTH = 320;

/** Height bounds for one block, in user units. See "why the heights are clamped". */
export const MIN_BLOCK_HEIGHT = 26;
export const MAX_BLOCK_HEIGHT = 90;

/** Outer padding, the gap between blocks, and the text inset. */
const PAD = 10;
const GAP = 3;
const TEXT_INSET = 10;

/** Height of the empty-state drawing, which has no blocks to be measured from. */
const EMPTY_HEIGHT = 40;

/**
 * A block shorter than this gets no visible text, because a glyph taller than
 * the box it sits in reads as a rendering fault rather than as a label. At the
 * current MIN_BLOCK_HEIGHT nothing reaches this branch; it exists so that
 * tightening the bounds later degrades to the aria-label instead of to clipped
 * text. The aria-label is never affected -- it is not drawn, so it cannot fit
 * badly.
 */
const TEXT_MIN_HEIGHT = 22;

/**
 * How many characters of a label fit across the block.
 *
 * A guess, and it has to be: this file sets no font-size, so it cannot know how
 * wide a character is. The real labels are all well inside this budget, so the
 * budget only bites on an unrecognised type whose raw key is printed verbatim,
 * which is exactly the case that would otherwise run off the edge of the
 * drawing. Visible text truncates; the aria-label never does.
 */
const LABEL_MAX_CHARS = 30;

/**
 * How tall is this section's block?
 *
 * Proportional to `maxWords` and then clamped, rather than interpolated between
 * the bounds, because the bounds are there to survive an outlier: a section
 * longer than `maxWords` is not a drawing error, it is a caller passing a corpus
 * ceiling rather than this page's own maximum, and the clamp is what stops it
 * becoming four thousand units of empty rectangle.
 *
 * Integers only, so the output is byte-stable and the coordinates below stay
 * exact.
 */
export function blockHeight(words, maxWords) {
  const w = Number.isFinite(words) && words > 0 ? words : 0;
  const max = Number.isFinite(maxWords) && maxWords > 0 ? maxWords : 0;
  if (max === 0) return MIN_BLOCK_HEIGHT;
  const raw = Math.round((w / max) * MAX_BLOCK_HEIGHT);
  return Math.min(MAX_BLOCK_HEIGHT, Math.max(MIN_BLOCK_HEIGHT, raw));
}

/** Sections in the order they appear on the page, whatever order they arrived in. */
function inOrder(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((s, i) => ({ section: s ?? {}, i }))
    .sort((a, b) => {
      const pa = Number.isFinite(a.section.position) ? a.section.position : a.i + 1;
      const pb = Number.isFinite(b.section.position) ? b.section.position : b.i + 1;
      // The index is the tie-break, so two sections claiming one position keep
      // the order they were handed to us rather than depending on sort internals.
      return pa - pb || a.i - b.i;
    })
    .map(({ section, i }) => ({
      position: Number.isFinite(section.position) ? section.position : i + 1,
      type: String(section.type ?? 'other'),
      heading: section.heading == null || section.heading === '' ? null : String(section.heading),
      words: Number.isFinite(section.words) && section.words > 0 ? section.words : 0,
    }));
}

/**
 * The sentence a screen reader gets for one block.
 *
 * A whole sentence rather than a fragment, because "proof" announced on its own
 * tells a reader nothing about where they are in the stack or how big the thing
 * is. Position and total come first so the reader can count; the heading is
 * quoted so it is audibly the company's words and not ours; the length closes
 * it, because length is the only thing the picture encodes that the text does
 * not otherwise say.
 *
 * The hero has no heading of its own -- that is the definition in
 * extract/anatomy.js, not a missing value -- so it says so rather than trailing
 * off into an empty pair of quotes.
 */
function ariaSentence({ position, type, heading, words }, total) {
  const where = `Section ${position} of ${total}: ${sectionLabel(type)}.`;
  const what = heading === null ? 'No heading.' : `Heading: "${heading}".`;
  const size = `${words} ${words === 1 ? 'word' : 'words'}.`;
  return `${where} ${what} ${size}`;
}

/** The visible label, truncated to what the block can hold. */
function visibleLabel(type) {
  const full = sectionLabel(type);
  if (full.length <= LABEL_MAX_CHARS) return escapeHtml(full);
  return `${escapeHtml(full.slice(0, LABEL_MAX_CHARS))}&hellip;`;
}

/**
 * A wireframe of one company's home page.
 *
 * @param {object} args
 * @param {string} args.slug      the company's slug, used only to make the title's id unique
 * @param {string} args.name      the company's name, for the drawing's accessible name
 * @param {{position: number, type: string, heading: string|null, words: number}[]} args.sections
 * @param {number} args.maxWords  the word count that maps to MAX_BLOCK_HEIGHT
 * @returns {string} an SVG element, ready to be dropped into the page
 */
export function renderWireframe({ slug, name, sections, maxWords }) {
  const list = inOrder(sections);
  const titleId = `wf-title-${escapeHtml(String(slug ?? ''))}`;
  const who = escapeHtml(String(name ?? slug ?? 'This page'));

  // No sequence to draw. This is a real state and not an error: twenty of the
  // two hundred pages in the corpus have no readable sections, because their
  // bands are not <h2>-headed. Returning nothing would leave a hole where the
  // reader expects a drawing and no explanation of why; returning an empty box
  // with a line of text in it says which of the two happened.
  if (list.length === 0) {
    return (
      `<svg class="wf" viewBox="0 0 ${WIREFRAME_WIDTH} ${EMPTY_HEIGHT}" width="100%" height="auto" ` +
      `role="group" aria-labelledby="${titleId}">` +
      `<title id="${titleId}">${who}: no readable section sequence.</title>` +
      `<text class="wf-empty" x="${PAD}" y="${Math.round(EMPTY_HEIGHT / 2)}" dominant-baseline="central">` +
      'No readable sections</text>' +
      '</svg>'
    );
  }

  const blockWidth = WIREFRAME_WIDTH - PAD * 2;
  const heights = list.map((s) => blockHeight(s.words, maxWords));
  const total = PAD * 2 + heights.reduce((sum, h) => sum + h, 0) + GAP * (list.length - 1);

  const blocks = [];
  let y = PAD;
  for (let i = 0; i < list.length; i++) {
    const section = list[i];
    const height = heights[i];

    // The type name lives in the aria-label whether or not it is drawn, which
    // is the whole point: the colour of the block is never the only thing
    // saying what the block is.
    const label = ariaSentence(section, list.length);
    const text = height >= TEXT_MIN_HEIGHT
      ? `<text class="wf-label" x="${PAD + TEXT_INSET}" y="${y + Math.round(height / 2)}" ` +
        `dominant-baseline="central">${visibleLabel(section.type)}</text>`
      : '';

    blocks.push(
      `<g class="wf-sec" data-section="${escapeHtml(String(section.position))}" ` +
      `data-type="${escapeHtml(section.type)}" tabindex="0" role="button" ` +
      `aria-label="${escapeHtml(label)}">` +
      `<rect class="wf-block wf-t-${escapeHtml(section.type)}" x="${PAD}" y="${y}" ` +
      `width="${blockWidth}" height="${height}" rx="3"></rect>` +
      text +
      '</g>'
    );

    y += height + GAP;
  }

  return (
    `<svg class="wf" viewBox="0 0 ${WIREFRAME_WIDTH} ${total}" width="100%" height="auto" ` +
    `role="group" aria-labelledby="${titleId}">` +
    `<title id="${titleId}">${who}: ${list.length} ` +
    `${list.length === 1 ? 'section' : 'sections'}, top to bottom, ` +
    'block height in proportion to the words in each.</title>' +
    blocks.join('') +
    '</svg>'
  );
}

/**
 * Kept honest at import time rather than at render time.
 *
 * A missing label is a build-time bug in this file, not a runtime condition a
 * caller can do anything about, so it is asserted here where it costs one pass
 * over seventeen strings, and again in the test suite where the failure names
 * the type that is missing.
 */
for (const type of [...SECTION_TYPES].sort()) {
  if (!Object.hasOwn(SECTION_LABEL, type)) {
    throw new Error(`anatomy-svg: SECTION_LABEL has no label for section type "${type}"`);
  }
}

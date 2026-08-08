/**
 * Page anatomy: the shape of the page, not the words on it.
 *
 * hero.js, proof.js and pricing.js read what a company *says*. This file reads
 * how the page is *built* -- how many blocks it has, what each block is for, and
 * in what order they appear. "Linear leads with proof and Notion leads with a
 * feature grid" is a fact about structure that no amount of headline extraction
 * will produce.
 *
 * WHAT COUNTS AS A SECTION
 * ------------------------
 * A section is the span of markup from one `<h2>` to the next, and the hero is
 * everything before the first one. That is the whole definition.
 *
 * It is not the definition anyone would write down in the abstract -- the
 * intuitive one is "a visually distinct band", which requires layout and
 * therefore a browser. This one requires only the document, it is stable across
 * CSS refactors in a way class names are not, and it happens to be how marketing
 * pages are actually authored: a band with no heading is decoration, and a band
 * with two headings is two ideas.
 *
 * It is wrong in two known ways, and both are recorded rather than hidden:
 *
 *   A page whose bands are headed by `<h3>` or by styled `<div>`s reads as one
 *   enormous hero. That is a null-shaped failure, and §"yield" below refuses to
 *   emit a section list of length one for a page with real content.
 *
 *   A page with a heading-per-feature inside one band over-counts. The
 *   classifier partly absorbs this: a run of short heading-led blocks with no
 *   other distinguishing content collapses to one `features` section.
 *
 * WHY THERE IS STILL NO DOM PARSER
 * --------------------------------
 * Same reason as html.js. Every scan here is one bounded pass over a
 * size-capped string using the shared `elements()` generator, and the whole file
 * is O(sections x section length) with a hard cap on both. See MAX_SECTIONS.
 *
 * NO GROUND TRUTH YET
 * -------------------
 * Every other signal in this project resolves to bytes a reader can re-read and
 * check. A section *type* does not: it is this file's opinion about a span of
 * markup. Until a hand-labelled validation set exists with a published accuracy
 * number, the distribution of section types is a distribution over this
 * classifier's behaviour, and the site must say so wherever it draws one.
 */

import { attr, collapse, elements, text } from './html.js';

/**
 * The section-type vocabulary.
 *
 * Ordered by how confidently each is recognised, because `classify()` returns
 * the first that matches and the earlier tests are the more specific ones. A
 * span matching nothing is `other`, which is a real answer and is counted.
 */
export const SECTION_TYPES = [
  'hero', 'logos', 'proof', 'testimonial', 'pricing', 'faq',
  'comparison', 'integrations', 'features', 'cta', 'media', 'other',
];

/** Hard cap on sections examined. A page past this is pathological, not deep. */
export const MAX_SECTIONS = 60;

/** Below this many words, a span is a band of chrome rather than a section. */
const MIN_SECTION_WORDS = 8;

const CURRENCY = /[$€£¥]|\b(?:USD|EUR|GBP|per\s+(?:month|user|seat)|\/mo\b)/i;
const QUANTIFIED = /\b\d[\d.,]*\s*(?:x\b|%|k\b|m\b|bn\b|billion|million|hours?|days?|weeks?|customers?|teams?|companies|users?)/i;
const QUESTION = /\?\s*$/;
const ACTION = /\b(?:get started|start (?:free|now|building)|try (?:it|for)|book a|request a|talk to|contact sales|sign up|see (?:a )?demo|watch (?:a )?demo|learn more|read (?:the )?docs)\b/i;
const INTEGRATION = /\bintegrat|\bconnect(?:s|ors?)?\b|\bworks with\b|\bapps?\b/i;
const TESTIMONY = /["“’']\s*\w|\bsays?\b|\bCEO\b|\bCTO\b|\bVP\b|\bHead of\b|\bDirector\b/i;

/**
 * Count matches without building an array, and stop early.
 *
 * `String.match(/g/)` on a megabyte allocates every match. Everything here
 * wants a bounded count, so it walks with `exec` and gives up at the cap.
 */
function countUpTo(re, s, cap = 500) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let n = 0;
  while (n < cap && r.exec(s) !== null) n++;
  return n;
}

/** Words in a plain-text span. */
function words(plain) {
  const t = plain.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Split a document into heading-anchored spans.
 *
 * Returns `[{ from, to, heading }]` with the hero first (heading null). Only
 * the `<main>` element is considered when the page has one: a `<header>` nav
 * and a `<footer>` are chrome on every page in the corpus and would otherwise
 * be counted as sections everywhere, which is a constant and therefore not a
 * signal.
 */
export function sectionSpans(doc) {
  const main = /<main\b[^>]*>/i.exec(doc);
  let body = doc;
  let base = 0;
  if (main) {
    const end = /<\/main\s*>/i.exec(doc.slice(main.index));
    base = main.index + main[0].length;
    body = doc.slice(base, end ? main.index + end.index : undefined);
  } else {
    const f = /<footer\b[^>]*>/i.exec(doc);
    if (f) body = doc.slice(0, f.index);
  }

  const anchors = [];
  for (const h of elements(body, 'h2', { limit: MAX_SECTIONS + 10 })) {
    anchors.push({ index: h.index, heading: collapse(text(h.inner)).slice(0, 160) });
  }

  const spans = [{ from: 0, to: anchors[0]?.index ?? body.length, heading: null }];
  for (let i = 0; i < anchors.length && spans.length <= MAX_SECTIONS; i++) {
    spans.push({
      from: anchors[i].index,
      to: anchors[i + 1]?.index ?? body.length,
      heading: anchors[i].heading,
    });
  }
  return { body, base, spans };
}

/** Everything the classifier needs from one span, counted once. */
function measure(fragment, isFirst) {
  const plain = collapse(text(fragment));
  const imgs = countUpTo(/<img\b/gi, fragment, 200);
  const links = countUpTo(/<a\b/gi, fragment, 300);
  return {
    isFirst,
    plain,
    words: words(plain),
    imgs,
    links,
    h3: countUpTo(/<h3\b/gi, fragment, 60),
    inputs: countUpTo(/<(?:input|select|textarea)\b/gi, fragment, 40),
    table: /<table\b/i.test(fragment),
    details: /<details\b/i.test(fragment),
    quote: /<blockquote\b/i.test(fragment),
    media: /<(?:video|iframe)\b/i.test(fragment),
    currency: CURRENCY.test(plain),
    quantified: QUANTIFIED.test(plain),
    action: ACTION.test(plain),
    integration: INTEGRATION.test(plain),
    testimony: TESTIMONY.test(plain),
  };
}

/**
 * What is this span for?
 *
 * First match wins, most specific first. Every branch is a judgement and the
 * order between them is a judgement too; both are why this file's output needs
 * a validation set before its distribution is published as a fact.
 */
export function classify(m, heading) {
  if (m.isFirst) return 'hero';
  if (m.words < MIN_SECTION_WORDS && m.imgs >= 4) return 'logos';
  // A wall of images with almost no prose is a logo strip whatever it is headed.
  if (m.imgs >= 6 && m.words / Math.max(m.imgs, 1) < 4) return 'logos';
  if (m.details || (heading && QUESTION.test(heading))) return 'faq';
  if (m.table && m.currency) return 'pricing';
  if (m.table) return 'comparison';
  if (m.currency && /\b(?:free|plan|pricing|per month|per user)\b/i.test(m.plain)) return 'pricing';
  if (m.quote || (m.testimony && m.words < 220)) return 'testimonial';
  if (m.quantified && m.words < 160) return 'proof';
  if (m.integration && m.imgs >= 4) return 'integrations';
  if (m.inputs >= 2) return 'cta';
  if (m.action && m.words < 80) return 'cta';
  if (m.media && m.words < 60) return 'media';
  if (m.h3 >= 2) return 'features';
  return 'other';
}

/**
 * Collapse a run of identical adjacent types into one.
 *
 * A page that heads every feature with its own `<h2>` produces `features`
 * eleven times, which describes the author's markup habits rather than the
 * page's shape. Two adjacent bands of the same kind are one band as far as the
 * reader is concerned.
 */
function collapseRuns(list) {
  const out = [];
  for (const s of list) {
    if (out.length && out.at(-1).type === s.type) { out.at(-1).spans++; continue; }
    out.push({ ...s, spans: 1 });
  }
  return out;
}

const sig = (value, method, confidence, json) =>
  (value === null || value === undefined ? null : { value, method, confidence, ...(json ? { json } : {}) });

/**
 * Every anatomy signal for one page.
 *
 * `doc` is script/style/SVG-stripped markup. `raw` is the original, needed only
 * for the nav and footer counts, which live outside `<main>`.
 */
export function extractAnatomy(doc, raw) {
  const { body, spans } = sectionSpans(doc);

  const classified = [];
  for (const s of spans.slice(0, MAX_SECTIONS)) {
    const fragment = body.slice(s.from, s.to);
    const m = measure(fragment, classified.length === 0);
    // A heading with nothing under it is a label, not a section.
    if (!m.isFirst && m.words < MIN_SECTION_WORDS && m.imgs < 4) continue;
    classified.push({ type: classify(m, s.heading), heading: s.heading, words: m.words });
  }

  const sections = collapseRuns(classified);

  // Yield gate. A real marketing page has more than one band; a single-section
  // result means the page heads its bands with something this file cannot see,
  // and that is a parser fault rather than a page with no structure.
  const plainAll = collapse(text(body));
  const totalWords = words(plainAll);
  if (sections.length <= 1 && totalWords > 300) {
    return {
      anatomy_sections: null,
      anatomy_section_count: null,
      anatomy_cta_count: null,
      anatomy_nav_links: null,
      anatomy_footer_links: null,
      anatomy_word_count: sig(totalWords, 'text:main', 0.8),
      anatomy_form_fields: null,
      anatomy_elements: null,
    };
  }

  const seq = sections.map((s) => s.type);

  // Nav and footer are chrome, and their size is a real positioning choice: a
  // twelve-item nav is a different company from a four-item nav.
  const navTag = /<nav\b[^>]*>/i.exec(raw);
  let navLinks = null;
  if (navTag) {
    const after = raw.slice(navTag.index, navTag.index + 40_000);
    const close = /<\/nav\s*>/i.exec(after);
    navLinks = countUpTo(/<a\b/gi, close ? after.slice(0, close.index) : after, 120);
  }
  const footTag = /<footer\b[^>]*>/i.exec(raw);
  let footLinks = null;
  if (footTag) {
    const after = raw.slice(footTag.index);
    const close = /<\/footer\s*>/i.exec(after);
    footLinks = countUpTo(/<a\b/gi, close ? after.slice(0, close.index) : after.slice(0, 120_000), 400);
  }

  const ctaCount = countUpTo(new RegExp(ACTION.source, 'gi'), plainAll, 60);
  const formFields = countUpTo(/<(?:input|select|textarea)\b/gi, doc, 60);

  const present = {
    logo_wall: seq.includes('logos'),
    proof: seq.includes('proof'),
    testimonial: seq.includes('testimonial'),
    faq: seq.includes('faq'),
    comparison: seq.includes('comparison'),
    pricing_block: seq.includes('pricing'),
    integrations: seq.includes('integrations'),
    media: seq.includes('media'),
  };

  return {
    anatomy_sections: sig(
      seq.join(' > '),
      'h2-anchored',
      0.6,
      { sections: sections.map((s, i) => ({ position: i + 1, type: s.type, heading: s.heading, words: s.words, merged: s.spans })) }
    ),
    anatomy_section_count: sig(String(sections.length), 'h2-anchored', 0.6),
    anatomy_cta_count: sig(String(ctaCount), 'action-phrase', 0.55),
    anatomy_nav_links: navLinks === null ? null : sig(String(navLinks), 'nav-anchors', 0.8),
    anatomy_footer_links: footLinks === null ? null : sig(String(footLinks), 'footer-anchors', 0.8),
    anatomy_word_count: sig(totalWords, 'text:main', 0.85),
    anatomy_form_fields: sig(String(formFields), 'form-controls', 0.85),
    anatomy_elements: sig(
      Object.entries(present).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none',
      'from-sections',
      0.6,
      { present }
    ),
  };
}

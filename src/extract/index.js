/**
 * Extraction orchestrator.
 *
 * One entry point, `extract()`, which takes a page body and returns a fixed set
 * of signals. Every signal is either an object with { value, method, confidence,
 * json? } or null. Nothing throws: a page that defeats every strategy produces
 * an all-null result, which the diff engine reads as "we learned nothing today",
 * not as "everything changed".
 *
 * CPU budget: the work here is 2 string passes to strip code and SVG, then a
 * fixed number of bounded regex scans. See src/extract/html.js for why there is
 * no DOM parser, and scripts/probe.js for measured timings against live pages.
 */

import { HERO_WINDOW, MAX_HTML, absoluteUrl, attr, collapse, stripCode, stripSvg, text } from './html.js';
import {
  extractCategory, extractHeadline, extractMetaDescription, extractMetaTitle, extractSubhead,
} from './hero.js';
import { extractLogos, extractProofPoints } from './proof.js';
import { extractPricingSignals } from './pricing.js';

/**
 * Bumped whenever a change to this directory could alter the value produced for
 * an unchanged page. Stored on every observation so a future reader can tell
 * "the company changed" from "we changed how we measure".
 *
 * See METHODOLOGY.md for what each version means.
 */
export const EXTRACTOR_VERSION = '1.0.0';

/**
 * How much of the document gets flattened to plain text for the regex-based
 * signals. Marketing pages put every claim above the footer; 300kB of markup is
 * far past that on every page in the seed, and the cap bounds worst-case CPU.
 */
export const PLAIN_WINDOW = 300_000;

/**
 * The signal registry. `kind` drives diff behaviour:
 *   text  -- compared as strings, magnitude is normalised edit distance
 *   list  -- compared as sets, protected by the list-collapse rule
 *   enum  -- small closed vocabulary, any change is significant
 */
export const SIGNALS = {
  headline:            { page: 'home',    kind: 'text', label: 'Hero headline' },
  subhead:             { page: 'home',    kind: 'text', label: 'Hero subhead' },
  category_label:      { page: 'home',    kind: 'text', label: 'Category label' },
  meta_title:          { page: 'home',    kind: 'text', label: 'Meta title' },
  meta_description:    { page: 'home',    kind: 'text', label: 'Meta description' },
  customer_logos:      { page: 'home',    kind: 'list', label: 'Customer logos' },
  proof_points:        { page: 'home',    kind: 'list', label: 'Proof points' },
  pricing_tiers:       { page: 'pricing', kind: 'list', label: 'Pricing tiers' },
  pricing_entry_price: { page: 'pricing', kind: 'text', label: 'Entry price' },
  pricing_free_tier:   { page: 'pricing', kind: 'enum', label: 'Free tier' },
  pricing_seat_minimum:{ page: 'pricing', kind: 'text', label: 'Seat minimum' },
  pricing_meta_title:  { page: 'pricing', kind: 'text', label: 'Pricing page title' },
};

export const SIGNAL_NAMES = Object.keys(SIGNALS);

/** Signals expected from a given page kind. */
export function signalsFor(kind) {
  return SIGNAL_NAMES.filter((s) => SIGNALS[s].page === kind);
}

/**
 * Document-level facts that are not signals but are needed to interpret them.
 *
 * `lang` in particular: a site that geo-routes us from /en to /de will produce
 * a completely different headline. That is not positioning drift, and the diff
 * engine needs to know. Confirmed live against klaviyo.com, stripe.com,
 * zendesk.com and snowflake.com, all of which redirect a German-egress client
 * to a localised page.
 */
export function documentFacts(raw, doc, url) {
  const htmlTag = /<html\b[^>]*>/i.exec(raw)?.[0] ?? '';
  const lang = (attr(htmlTag, 'lang') ?? '').toLowerCase().split(/[-_]/)[0] || null;
  const canonicalTag = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(doc)?.[0] ?? '';
  const canonical = absoluteUrl(attr(canonicalTag, 'href'), url);
  return { lang, canonical };
}

/**
 * Does this body look like an HTML document at all?
 *
 * A surprising number of hosts answer an identified crawler with something
 * else. ramp.com serves text/markdown ("Ramp -- Machine Version") to any client
 * that is not a real browser. We refuse to extract from those: the signals
 * would not be comparable with the HTML everyone else serves, and quietly
 * mixing them would corrupt the series.
 */
export function classifyBody(body, contentType = '') {
  const ct = contentType.toLowerCase();
  if (ct.includes('markdown')) return { variant: 'agent-markdown', extractable: false };
  if (ct.includes('json')) return { variant: 'json', extractable: false };
  if (ct && !ct.includes('html') && !ct.includes('xml') && !ct.includes('text/plain')) {
    return { variant: ct.split(';')[0].trim(), extractable: false };
  }
  const head = body.slice(0, 4000);
  if (!/<html[\s>]|<!doctype\s+html/i.test(head)) {
    if (/^\s*#{1,3}\s+\S/m.test(head)) return { variant: 'agent-markdown', extractable: false };
    return { variant: 'not-html', extractable: false };
  }
  return { variant: 'html', extractable: true };
}

/**
 * Extract every signal for one page.
 *
 * @param {'home'|'pricing'} kind
 * @param {string} body    raw response text
 * @param {string} url     final URL after redirects
 * @param {{brand?: string, contentType?: string}} opts
 */
export function extract(kind, body, url, opts = {}) {
  const raw = (body ?? '').slice(0, MAX_HTML);
  const classification = classifyBody(raw, opts.contentType ?? '');

  const signals = Object.fromEntries(signalsFor(kind).map((s) => [s, null]));
  const base = {
    extractorVersion: EXTRACTOR_VERSION,
    variant: classification.variant,
    extractable: classification.extractable,
    truncated: (body ?? '').length > MAX_HTML,
    signals,
  };

  if (!classification.extractable) {
    return { ...base, lang: null, canonical: null };
  }

  // Pass 1: drop scripts/styles/comments but keep inline SVG (logo walls).
  const withSvg = stripCode(raw);
  // Pass 2: drop SVG for everything that reads text.
  const doc = stripSvg(withSvg);

  const { lang, canonical } = documentFacts(raw, doc, url);

  // Flatten to plain text exactly once. A full tag-strip over a megabyte is one
  // of the two most expensive operations in the pipeline; three extractors need
  // it, so it is computed here and shared rather than recomputed per signal.
  const plain = collapse(text(doc.slice(0, PLAIN_WINDOW)));

  if (kind === 'home') {
    const metaTitle = extractMetaTitle(doc, raw);
    const metaDescription = extractMetaDescription(doc);
    const headline = extractHeadline(doc, { brand: opts.brand });
    const subhead = extractSubhead(doc, headline);
    const category = extractCategory(doc, raw, { headline, metaTitle, metaDescription, subhead });

    signals.meta_title = metaTitle;
    signals.meta_description = metaDescription;
    // `index` is an internal offset used to find the subhead; it must not leak
    // into the stored observation.
    signals.headline = headline ? stripIndex(headline) : null;
    signals.subhead = subhead;
    signals.category_label = category;
    signals.customer_logos = extractLogos(withSvg, { brand: opts.brand });
    signals.proof_points = extractProofPoints(plain);
  } else {
    const priced = extractPricingSignals(doc, raw, plain);
    signals.pricing_tiers = priced.pricing_tiers;
    signals.pricing_entry_price = priced.pricing_entry_price;
    signals.pricing_free_tier = priced.pricing_free_tier;
    signals.pricing_seat_minimum = priced.pricing_seat_minimum;
    const t = extractMetaTitle(doc, raw);
    signals.pricing_meta_title = t;
  }

  return { ...base, lang, canonical };
}

function stripIndex({ index, ...rest }) {
  return rest;
}

/** How many signals came back non-null. Used to detect structural collapse. */
export function yieldOf(result) {
  return Object.values(result.signals).filter(Boolean).length;
}

export { HERO_WINDOW, MAX_HTML };

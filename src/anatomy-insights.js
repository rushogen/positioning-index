/**
 * Cross-sectional read models for page anatomy.
 *
 * insights.js answers "what do these companies say". This file answers "how are
 * their pages built" -- section sequences, what sits in position two, how many
 * links are in a footer, how much prose a homepage carries.
 *
 * Same rules as insights.js, and one more.
 *
 *   1. A null is "not readable", never zero. A page whose bands are not
 *      <h2>-headed has no readable sequence; it does not have a sequence of
 *      length zero, and it is named in the coverage block rather than averaged
 *      into a denominator.
 *   2. Nothing is imputed.
 *   3. Every percentage carries the n that produced it.
 *   4. Every derived grouping is inspectable: each bucket carries the companies
 *      in it and the exact value that put them there.
 *
 *   5. THE CLASSIFIER'S UNCERTAINTY IS PUBLISHED, NOT HIDDEN. A section type is
 *      this project's opinion about a span of markup, and it is the only signal
 *      family here that does not resolve to bytes a reader can re-check. So
 *      `classifierQuality()` reports the share of sections that landed in
 *      `other`, and the site prints it beside every anatomy chart. A rising
 *      `other` rate is the extractor losing touch with how the web is built,
 *      and it is the number to watch before trusting any of the rest.
 *
 * All output is sorted so `npm run build` twice produces identical bytes.
 */

import { latestByCompany, signalJson, signalStatus, signalValue } from './insights.js';
import { SECTION_TYPES } from './extract/anatomy.js';

/** The parsed section list for one company, or null if it was not readable. */
export function sectionsOf(signals) {
  const json = signalJson(signals, 'anatomy_sections');
  return Array.isArray(json?.sections) && json.sections.length ? json.sections : null;
}

/** A numeric anatomy signal as a number, or null. */
function numberOf(signals, name) {
  const v = signalValue(signals, name);
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const pct = (n, of) => (of === 0 ? null : Math.round((n / of) * 1000) / 10);

/** Quantiles from an unsorted list, without pulling in a stats library. */
function quantiles(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, min: s[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: s.at(-1) };
}

function coverageOf(rows, readable) {
  const missing = rows.filter((r) => !readable(r)).map((r) => ({ slug: r.slug, name: r.name }));
  return {
    tracked: rows.length,
    readable: rows.length - missing.length,
    unreadable: missing.length,
    held: 0,
    suspect: 0,
    missing: missing.sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

/**
 * How much of what the classifier produced it could actually name.
 *
 * Published beside every other number on the anatomy view. This is the one
 * figure that says how far to trust the rest.
 */
export function classifierQuality({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  let sections = 0;
  let other = 0;
  const worst = [];
  for (const r of rows) {
    const list = sectionsOf(r.signals);
    if (!list) continue;
    const o = list.filter((s) => s.type === 'other').length;
    sections += list.length;
    other += o;
    if (o) worst.push({ slug: r.slug, name: r.name, other: o, of: list.length });
  }
  return {
    sections,
    other,
    named: sections - other,
    other_share: pct(other, sections),
    companies_with_other: worst
      .sort((a, b) => b.other - a.other || a.name.localeCompare(b.name, 'en'))
      .slice(0, 20),
    note:
      'A section type is this project’s opinion about a span of markup, not a value read '
      + 'off the page. `other` is what the classifier could not name, and it is counted rather '
      + 'than absorbed into a neighbouring type. There is no hand-labelled validation set yet, '
      + 'so this share is the only published measure of how well the classifier is doing.',
  };
}

/**
 * What sits in each position across the corpus.
 *
 * The single most useful anatomy view: position one is almost always the hero,
 * and what a market puts in position two is a real convention that a reader can
 * compare a page against.
 */
export function positionProfile({ companies, series, depth = 8 }) {
  const rows = latestByCompany({ companies, series });
  const readable = rows.filter((r) => sectionsOf(r.signals));
  const positions = [];
  for (let i = 0; i < depth; i++) {
    const at = readable
      .map((r) => ({ r, type: sectionsOf(r.signals)[i]?.type ?? null }))
      .filter((x) => x.type);
    if (!at.length) break;
    const counts = new Map();
    for (const { r, type } of at) {
      if (!counts.has(type)) counts.set(type, []);
      counts.get(type).push({ slug: r.slug, name: r.name });
    }
    positions.push({
      position: i + 1,
      n: at.length,
      types: [...counts.entries()]
        .map(([type, cos]) => ({
          type,
          n: cos.length,
          share: pct(cos.length, at.length),
          companies: cos.sort((a, b) => a.name.localeCompare(b.name, 'en')),
        }))
        .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
    });
  }
  return { positions, coverage: coverageOf(rows, (r) => sectionsOf(r.signals)) };
}

/**
 * Which structural elements a page carries at all, regardless of order.
 *
 * Derived from the sequence rather than measured separately, so the two can
 * never disagree.
 */
export function elementPrevalence({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  const readable = rows.filter((r) => sectionsOf(r.signals));
  const kinds = SECTION_TYPES.filter((t) => t !== 'hero' && t !== 'other');
  const elements = kinds
    .map((type) => {
      const has = readable.filter((r) => sectionsOf(r.signals).some((s) => s.type === type));
      return {
        type,
        n: has.length,
        of: readable.length,
        share: pct(has.length, readable.length),
        companies: has.map((r) => ({ slug: r.slug, name: r.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'en')),
      };
    })
    .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type));
  return { elements, coverage: coverageOf(rows, (r) => sectionsOf(r.signals)) };
}

/** Distributions for the plain numeric anatomy signals. */
export function anatomyScales({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  const scales = [
    ['anatomy_section_count', 'Sections on the page'],
    ['anatomy_cta_count', 'Calls to action'],
    ['anatomy_nav_links', 'Links in the nav'],
    ['anatomy_footer_links', 'Links in the footer'],
    ['anatomy_word_count', 'Words on the page'],
    ['anatomy_form_fields', 'Form fields'],
  ].map(([signal, label]) => {
    const withValue = rows
      .map((r) => ({ r, v: numberOf(r.signals, signal) }))
      .filter((x) => x.v !== null);
    return {
      signal,
      label,
      ...quantiles(withValue.map((x) => x.v)),
      coverage: coverageOf(rows, (r) => numberOf(r.signals, signal) !== null),
      extremes: {
        lowest: withValue.slice().sort((a, b) => a.v - b.v).slice(0, 5)
          .map((x) => ({ slug: x.r.slug, name: x.r.name, value: x.v })),
        highest: withValue.slice().sort((a, b) => b.v - a.v).slice(0, 5)
          .map((x) => ({ slug: x.r.slug, name: x.r.name, value: x.v })),
      },
    };
  });
  return { scales };
}

/**
 * Every company's sequence, for the drill-down.
 *
 * This is the raw material the strip diagram renders, and it is published so
 * that every aggregate above can be re-derived by anyone who disagrees with it.
 */
export function companyStrips({ companies, series }) {
  const rows = latestByCompany({ companies, series });
  return rows
    .map((r) => {
      const list = sectionsOf(r.signals);
      return {
        slug: r.slug,
        name: r.name,
        segment: r.segment,
        status: signalStatus(r.signals, 'anatomy_sections'),
        sections: list
          ? list.map((s) => ({ position: s.position, type: s.type, heading: s.heading, words: s.words }))
          : null,
        words: numberOf(r.signals, 'anatomy_word_count'),
        nav_links: numberOf(r.signals, 'anatomy_nav_links'),
        footer_links: numberOf(r.signals, 'anatomy_footer_links'),
        cta_count: numberOf(r.signals, 'anatomy_cta_count'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Everything the anatomy view needs, in one deterministic object. */
export function pageAnatomy({ companies, series }) {
  return {
    quality: classifierQuality({ companies, series }),
    positions: positionProfile({ companies, series }),
    elements: elementPrevalence({ companies, series }),
    scales: anatomyScales({ companies, series }),
    companies: companyStrips({ companies, series }),
    vocabulary: SECTION_TYPES,
  };
}

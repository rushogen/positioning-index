/**
 * Pricing-page signals.
 *
 * Four signals come out of here, and three of them are DERIVED from the first:
 *
 *   pricing_tiers        the list of published plans and their headline prices
 *   pricing_entry_price  cheapest non-zero tier               <- derived
 *   pricing_free_tier    whether a $0 plan is published       <- derived
 *   pricing_seat_minimum smallest purchasable number of seats <- independent
 *
 * The derivation matters for correctness. If tier extraction fails, we do not
 * know whether a free tier exists -- and "no free tier found" is a value, not
 * an absence. Emitting `no` on a run where the parser broke would manufacture
 * a headline change ("Notion removed its free plan") out of our own bug.
 *
 * So: when `pricing_tiers` is null, every derived signal is null too. That is
 * enforced here rather than left to the caller, and tested in
 * tests/pricing.test.js.
 */

import { clean, collapse, elements, headingText, jsonLd, text } from './html.js';

const ok = (value, method, confidence, json) =>
  value ? { value, method, confidence, ...(json !== undefined ? { json } : {}) } : null;

const CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

/**
 * Prices in either order: "$12" and "12 €" (the European convention, which we
 * will see whenever a site geo-routes us to a EU locale).
 */
const PRICE_RE =
  /(?:(?:US|CA|AU|NZ|SG)?\s?([$€£¥₹])\s?(\d{1,3}(?:[,  ]\d{3})*(?:[.,]\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)|(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?)\s?([€£])|\b(USD|EUR|GBP)\s?(\d{1,6}(?:[.,]\d{1,2})?))/g;

/**
 * Billing period only. Seat units are matched separately by SEAT_UNIT_RE,
 * because "$10 per user per month" carries both and conflating them produced
 * nonsense like "USD 10/user/user".
 */
const PERIOD_RE =
  /\/\s*(mo|month|yr|year)\b|per\s+(month|year)\b|\b(monthly|annually|yearly|a\s+month|a\s+year)\b/i;

const SEAT_UNIT_RE = /\b(?:per|\/)\s*(user|seat|member|agent|licen[cs]e|contact|editor|host|admin)\b/i;

/** Words that make a short heading a plausible plan name. */
const TIER_WORDS = new RegExp(
  '\\b(?:' + [
    'free', 'freemium', 'starter', 'start', 'basic', 'essential', 'essentials', 'standard',
    'core', 'lite', 'light', 'plus', 'pro', 'professional', 'premium', 'advanced', 'team',
    'teams', 'business', 'growth', 'scale', 'company', 'organisation', 'organization',
    'enterprise', 'ultimate', 'unlimited', 'custom', 'individual', 'personal', 'solo',
    'startup', 'developer', 'developers', 'hobby', 'community', 'cloud', 'dedicated',
    'suite', 'max', 'ultra', 'launch', 'build', 'grow', 'expert', 'elite', 'plan',
  ].join('|') + ')\\b', 'i'
);

const CONTACT_SALES =
  /\b(?:contact (?:us|sales)|talk to (?:us|sales|an expert)|get (?:a )?(?:quote|demo)|custom pricing|let'?s talk|request pricing|book a demo)\b/i;

const FREE_PHRASE =
  /\b(?:free forever|free plan|free tier|always free|free for(?:ever)?\b|start(?:s|ing)? (?:for )?free|\$\s?0\b|€\s?0\b|0\s?€|£\s?0\b|no cost)\b/i;

function toNumber(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[  ]/g, '');
  // 1.234,56 (EU) vs 1,234.56 (US): the last separator is the decimal point.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // A lone comma is a thousands separator when followed by exactly 3 digits.
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function matchPrice(m) {
  if (m[1]) return { currency: CURRENCY[m[1]] ?? m[1], amount: toNumber(m[2]) };
  if (m[4]) return { currency: CURRENCY[m[4]] ?? m[4], amount: toNumber(m[3]) };
  if (m[5]) return { currency: m[5], amount: toNumber(m[6]) };
  return null;
}

function periodFrom(tail) {
  const p = PERIOD_RE.exec(tail);
  if (!p) return null;
  const w = (p[1] ?? p[2] ?? p[3] ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(?:mo|month|monthly|a month)$/.test(w)) return 'month';
  if (/^(?:yr|year|annually|yearly|a year)$/.test(w)) return 'year';
  return null;
}

/** Marketing badges get rendered inside the plan heading on plenty of sites. */
const TIER_BADGE = /\b(?:most\s+)?(?:recommended|popular|best\s+value|new|beta|coming\s+soon|current\s+plan|save\s+\d+%?)\b/gi;

function cleanTierName(name) {
  const s = collapse(String(name ?? '').replace(TIER_BADGE, ' '))
    .replace(/^[^\w]+|[^\w)+]+$/g, '');
  return s || null;
}

/** Headings and plan-card titles, with their document offsets. */
function collectAnchors(html) {
  const anchors = [];
  for (const tag of ['h2', 'h3', 'h4', 'h5', 'dt']) {
    for (const el of elements(html, tag, { limit: 120, maxInner: 3000 })) {
      const t = cleanTierName(clean(headingText(el.inner), 60));
      if (t) anchors.push({ name: t, index: el.index, source: tag });
    }
  }
  // Design systems commonly mark the plan name with a class rather than a heading.
  const classy = /<(?:div|span|p|h\d)\b[^>]*class\s*=\s*["'][^"']*(?:plan|tier|package|pricing)[-_]?(?:name|title|heading|label)[^"']*["'][^>]*>([\s\S]{0,120}?)<\//gi;
  let m;
  let n = 0;
  while ((m = classy.exec(html)) !== null && n++ < 80) {
    const t = cleanTierName(clean(headingText(m[1]), 60));
    if (t) anchors.push({ name: t, index: m.index, source: 'class' });
  }
  anchors.sort((a, b) => a.index - b.index);
  return anchors;
}

function plausibleTierName(name) {
  if (!name) return false;
  const words = name.split(/\s+/);
  if (words.length > 3 || name.length > 28) return false;
  if (!/[A-Za-z]/.test(name)) return false;
  return true;
}

const ANCHOR_REACH = 2500;

/**
 * Structured pricing from JSON-LD. Rare on marketing pricing pages but exact
 * when present, so it is tried first.
 */
function tiersFromJsonLd(raw) {
  const tiers = [];
  for (const node of jsonLd(raw)) {
    const offers = node.offers ?? node.hasOfferCatalog?.itemListElement;
    const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      const spec = o.priceSpecification ?? o;
      const amount = toNumber(spec.price ?? o.price);
      const currency = spec.priceCurrency ?? o.priceCurrency ?? null;
      const name = clean(o.name ?? o.itemOffered?.name ?? node.name, 40);
      if (amount === null || !name) continue;
      tiers.push({ name, amount, currency, period: spec.billingDuration ?? null, unit: null, source: 'json-ld' });
    }
  }
  return tiers;
}

/**
 * The heuristic path: find every price on the page, attach each to the nearest
 * plausible plan name above it, then add name-only tiers (Free, Enterprise)
 * that carry no numeric price.
 */
function tiersFromHeuristics(doc) {
  const anchors = collectAnchors(doc);
  if (anchors.length === 0) return [];

  const byAnchor = new Map();

  PRICE_RE.lastIndex = 0;
  let m;
  let n = 0;
  while ((m = PRICE_RE.exec(doc)) !== null && n++ < 400) {
    const price = matchPrice(m);
    if (!price || price.amount === null || price.amount > 100_000) continue;

    // Nearest preceding anchor.
    let anchor = null;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i].index < m.index) {
        if (m.index - anchors[i].index <= ANCHOR_REACH) anchor = anchors[i];
        break;
      }
    }
    if (!anchor || !plausibleTierName(anchor.name)) continue;
    if (!TIER_WORDS.test(anchor.name) && anchor.source !== 'class') continue;

    const tail = collapse(text(doc.slice(m.index + m[0].length, m.index + m[0].length + 120)));
    const key = anchor.name.toLowerCase();
    if (byAnchor.has(key)) continue; // first price under a heading is the headline price
    byAnchor.set(key, {
      name: anchor.name,
      amount: price.amount,
      currency: price.currency,
      period: periodFrom(tail),
      unit: SEAT_UNIT_RE.exec(tail)?.[1]?.toLowerCase() ?? null,
      index: anchor.index,
      source: 'heuristic',
    });
  }

  // Priceless tiers: "Free" with no number, "Enterprise -- contact sales".
  for (const a of anchors) {
    if (!plausibleTierName(a.name) || !TIER_WORDS.test(a.name)) continue;
    const key = a.name.toLowerCase();
    if (byAnchor.has(key)) continue;
    const window = collapse(text(doc.slice(a.index, a.index + 900)));
    if (/^free\b/i.test(a.name) || FREE_PHRASE.test(window.slice(0, 200))) {
      byAnchor.set(key, { name: a.name, amount: 0, currency: null, period: null, unit: null, index: a.index, source: 'free-phrase' });
    } else if (CONTACT_SALES.test(window.slice(0, 300))) {
      byAnchor.set(key, { name: a.name, amount: null, currency: null, period: null, unit: null, index: a.index, source: 'contact-sales' });
    }
  }

  return [...byAnchor.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

const fmt = (t) => {
  if (t.amount === null) return `${t.name} custom`;
  if (t.amount === 0) return `${t.name} free`;
  const cur = t.currency ? `${t.currency} ` : '';
  const unit = t.unit ? `/${t.unit}` : '';
  const per = t.period && t.period !== t.unit ? `/${t.period}` : '';
  return `${t.name} ${cur}${t.amount}${unit}${per}`;
};

/**
 * `doc` is stripNonContent output, `raw` the original body (needed for JSON-LD).
 * Returns the four pricing signals, with the derived ones nulled out whenever
 * the base signal failed.
 */
export function extractPricingSignals(doc, raw, plain) {
  const plainText = plain ?? collapse(text(doc.slice(0, 300_000)));
  let tiers = tiersFromJsonLd(raw ?? doc);
  let method = 'json-ld:offers';
  let confidence = 0.95;

  if (tiers.length < 2) {
    tiers = tiersFromHeuristics(doc);
    method = 'heuristic:anchor+price';
    confidence = 0.7;
  }

  // One tier is not a pricing table; it is a stray currency symbol next to a
  // heading. Refusing to guess here is what keeps `pricing_free_tier` honest.
  if (tiers.length < 2) {
    return {
      pricing_tiers: null,
      pricing_entry_price: null,
      pricing_free_tier: null,
      pricing_seat_minimum: extractSeatMinimum(plainText),
    };
  }

  const clean_tiers = tiers.slice(0, 8).map(({ index, ...rest }) => rest);
  const value = clean_tiers.map(fmt).join(' | ');

  const paid = clean_tiers.filter((t) => typeof t.amount === 'number' && t.amount > 0);
  const entry = paid.length ? paid.reduce((lo, t) => (t.amount < lo.amount ? t : lo)) : null;
  const hasFree = clean_tiers.some((t) => t.amount === 0) || FREE_PHRASE.test(plainText);

  return {
    pricing_tiers: ok(value, method, confidence, { tiers: clean_tiers, count: clean_tiers.length }),
    pricing_entry_price: entry
      ? ok(
          fmt(entry).replace(`${entry.name} `, ''),
          `${method}:min`,
          confidence,
          { amount: entry.amount, currency: entry.currency, period: entry.period, unit: entry.unit, tier: entry.name }
        )
      : null,
    pricing_free_tier: ok(hasFree ? 'yes' : 'no', method, confidence, { free: hasFree }),
    pricing_seat_minimum: extractSeatMinimum(plainText),
  };
}

const SEAT_MIN_PATTERNS = [
  /\bminimum(?:\s+of)?\s+(\d{1,4})\s+(seats?|users?|licen[cs]es?|members?|employees?)\b/i,
  /\b(\d{1,4})\s+(seats?|users?|licen[cs]es?|members?)\s+minimum\b/i,
  /\bstarts?\s+at\s+(\d{1,4})\s+(seats?|users?|licen[cs]es?)\b/i,
  /\bbilled\s+for\s+(?:a\s+minimum\s+of\s+)?(\d{1,4})\s+(seats?|users?)\b/i,
  /\brequires?\s+(?:a\s+)?minimum\s+(?:of\s+)?(\d{1,4})\s+(seats?|users?)\b/i,
];

/**
 * Seat minimums. Independent of tier extraction because the phrasing lives in
 * body copy or a footnote, not in the plan card.
 *
 * Absence is genuinely ambiguous here -- most companies publish no minimum --
 * so null means "no claim found", and the diff engine's removal rules apply
 * before we would ever assert that a minimum was dropped.
 */
export function extractSeatMinimum(plain) {
  for (const re of SEAT_MIN_PATTERNS) {
    const m = re.exec(plain);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1 || n > 5000) continue;
    const unit = m[2].toLowerCase().replace(/s$/, '');
    return ok(`${n} ${unit}${n === 1 ? '' : 's'}`, 'regex:seat-minimum', 0.8, { seats: n, unit });
  }
  return null;
}

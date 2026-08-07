/**
 * Social-proof signals: customer logos and quantified proof points.
 *
 * Both are LIST signals, which changes how they must be handled downstream. A
 * text signal going from "X" to "Y" is one bit of evidence. A list going from
 * 14 items to 0 is almost never a company removing every customer logo; it is
 * almost always our selector breaking against a redesign. src/diff.js encodes
 * that asymmetry; see LIST_COLLAPSE_RATIO there.
 */

import { attr, clean, collapse, elements, text } from './html.js';

const ok = (value, method, confidence, json) =>
  value ? { value, method, confidence, ...(json !== undefined ? { json } : {}) } : null;

// ---------------------------------------------------------------------------
// customer logos
// ---------------------------------------------------------------------------

/** Phrases that introduce a logo wall. Case-insensitive, matched against text. */
const PROOF_LEAD = /(?:trusted by|powering|used by|loved by|join(?:ed by)?\s+(?:over\s+)?[\d,]+|our customers|customers include|companies (?:that|of all)|built for teams at|works with|the best teams|teams at|from startups to|backed by)/i;

/** How much markup after a lead phrase counts as "the logo wall". */
const LOGO_WINDOW = 14_000;

/** Generic image names that are never a customer. */
const NOT_A_COMPANY = new RegExp(
  '^(?:' + [
    'icon', 'icons', 'arrow', 'arrows', 'star', 'stars', 'chevron', 'check', 'checkmark',
    'close', 'menu', 'hamburger', 'search', 'avatar', 'avatars', 'placeholder', 'image',
    'img', 'photo', 'picture', 'hero', 'background', 'bg', 'banner', 'screenshot',
    'illustration', 'pattern', 'shape', 'blob', 'gradient', 'divider', 'quote', 'quotes',
    'play', 'pause', 'video', 'thumbnail', 'thumb', 'header', 'footer', 'nav', 'card',
    'logo', 'logos', 'logotype', 'brand', 'brands', 'customer', 'customers', 'client',
    'clients', 'partner', 'partners', 'company', 'companies', 'wordmark', 'mark', 'symbol',
    'graphic', 'asset', 'sprite', 'spacer', 'pixel', 'dot', 'line', 'grid', 'blur',
    'light', 'dark', 'white', 'black', 'grey', 'gray', 'color', 'colour', 'mono',
    'default', 'undefined', 'null', 'untitled', 'group', 'frame', 'vector', 'union',
    'ellipse', 'rectangle', 'path', 'layer', 'mask', 'clip', 'fill', 'stroke',
    'desktop', 'mobile', 'tablet', 'small', 'medium', 'large', 'new', 'old', 'temp',
  ].join('|') + ')$', 'i'
);

/** Decoration words to peel off a candidate before judging it. */
const DECORATION = /\b(?:logo(?:type|mark)?s?|wordmark|icon|colou?r(?:ed)?|white|black|dark|light|mono(?:chrome)?|grey|gray|red|blue|green|yellow|orange|purple|inverted|full|primary|secondary|small|large|new|final|copy|vector|svg|png|webp|transparent|2x|3x|v\d+)\b/gi;

/**
 * Alt text on a marketing page is frequently a call to action rather than a
 * name ("Read the story", "Watch the demo"). Those must never enter the logo
 * list, or a hero carousel swap reads as a customer churning.
 */
const CTA_ALT = /^(?:read|learn|see|view|watch|get|try|start|click|open|download|explore|discover|book|request|contact|sign|log|join|go|find|browse|shop|buy|play|listen|subscribe|follow|share|next|prev|previous|back|close|expand|collapse|show|hide|more|all)\b/i;

function normaliseName(candidate) {
  if (!candidate) return null;
  if (CTA_ALT.test(collapse(String(candidate)))) return null;
  let s = collapse(String(candidate))
    .replace(/[_+]/g, ' ')
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/['’]s\b/gi, '')
    .replace(/\.(?:svg|png|jpe?g|webp|avif|gif)$/i, '');
  s = collapse(s.replace(DECORATION, ' '));
  // Strip content-hash suffixes webpack/next like to append.
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, '').replace(/\b\d{2,}\b/g, '');
  s = collapse(s).replace(/\s+[a-z]$/i, '').replace(/^[^\w]+|[^\w)]+$/g, '');
  if (!s) return null;
  if (s.length < 2 || s.length > 30) return null;
  if (NOT_A_COMPANY.test(s)) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  // Anything with more than four words is a sentence, not a company name.
  if (s.split(' ').length > 4) return null;
  return s;
}

/** Company name out of an image src: take the basename and clean it up. */
function nameFromSrc(src) {
  if (!src || src.startsWith('data:')) return null;
  const path = src.split('?')[0].split('#')[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!base) return null;
  // Next.js image proxy: /_next/image?url=... -- already stripped by split('?').
  return normaliseName(decodeURIComponent(base));
}

function nameFromAlt(alt) {
  if (!alt) return null;
  const a = collapse(alt);
  // "Logo of Shopify" / "Shopify logo" / "Shopify's logo"
  const of = /^(?:the\s+)?logo\s+(?:of|for)\s+(.+)$/i.exec(a);
  return normaliseName(of ? of[1] : a);
}

/**
 * Extract the customer logo wall.
 *
 * `html` must be the stripCode() output, i.e. scripts removed but inline SVG
 * still present, since a large share of logo walls are inline SVG with a
 * <title>.
 */
export function extractLogos(html, { brand } = {}) {
  const inWall = new Map();   // name -> source, found inside a "trusted by" region
  const anywhere = new Map(); // name -> source, found by the generic logo heuristic

  // Locate candidate logo-wall regions by their lead phrase.
  const regions = [];
  const leadGlobal = new RegExp(PROOF_LEAD.source, 'gi');
  let lead;
  let leads = 0;
  while ((lead = leadGlobal.exec(html)) !== null && leads++ < 8) {
    regions.push([lead.index, Math.min(lead.index + LOGO_WINDOW, html.length)]);
    leadGlobal.lastIndex = lead.index + LOGO_WINDOW;
  }
  const inRegion = (i) => regions.some(([a, b]) => i >= a && i <= b);

  const record = (name, source, index) => {
    if (!name) return;
    if (brand && name.toLowerCase() === brand.toLowerCase()) return;
    const key = name.toLowerCase();
    if (inRegion(index)) {
      if (!inWall.has(key)) inWall.set(key, { name, source });
    } else if (!anywhere.has(key)) {
      anywhere.set(key, { name, source });
    }
  };

  for (const { tag, index } of elements(html, 'img', { void: true, limit: 500 })) {
    const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'srcset')?.split(/[ ,]/)[0];
    const alt = attr(tag, 'alt');
    const cls = attr(tag, 'class') ?? '';
    const looksLikeLogo =
      /logo|customer|client|partner|brand/i.test(cls) ||
      /logo/i.test(src ?? '') ||
      /\blogo\b/i.test(alt ?? '');
    if (!inRegion(index) && !looksLikeLogo) continue;
    record(nameFromAlt(alt) ?? nameFromSrc(src), alt ? 'alt' : 'filename', index);
  }

  // Inline SVG logo walls: <svg><title>Shopify</title>...
  for (const { tag, inner, index } of elements(html, 'svg', { limit: 300, maxInner: 2500 })) {
    const cls = `${attr(tag, 'class') ?? ''} ${attr(tag, 'aria-label') ?? ''}`;
    if (!inRegion(index) && !/logo|customer|client|partner|brand/i.test(cls)) continue;
    const title = /<title\b[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(inner)?.[1];
    record(normaliseName(text(title ?? '')) ?? normaliseName(attr(tag, 'aria-label')), 'svg-title', index);
  }

  const wall = [...inWall.values()];
  const loose = [...anywhere.values()];
  // Prefer the logo wall; fall back to the loose heuristic only if the wall is thin.
  const chosen = wall.length >= 3 ? wall : [...wall, ...loose];
  const method = wall.length >= 3 ? 'proof-region' : 'logo-heuristic';
  const confidence = wall.length >= 3 ? 0.85 : 0.5;

  // Below three names it is noise, not a logo wall.
  if (chosen.length < 3) return null;

  const names = [...new Set(chosen.map((c) => c.name))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, 40);

  return ok(names.join(', '), method, confidence, {
    names,
    count: names.length,
    lead: regions.length ? collapse(text(html.slice(regions[0][0], regions[0][0] + 200))).slice(0, 80) : null,
  });
}

// ---------------------------------------------------------------------------
// proof points
// ---------------------------------------------------------------------------

const COUNT_NOUNS =
  'teams|companies|customers|users|developers|businesses|organi[sz]ations|brands|engineers|' +
  'hours|people|merchants|creators|stores|enterprises|employees|websites|apps|requests|' +
  'events|records|leads|deals|integrations|downloads|installs|projects|repositories|' +
  'workflows|messages|transactions|queries|models|agents|sites|accounts|seats|members';

const CLAIM_VERBS =
  'faster|slower|quicker|fewer|more|less|higher|lower|better|cheaper|greater|larger|smaller|' +
  'increase|decrease|reduction|growth|uplift|improvement|savings|saved|reduced|increased|' +
  'improved|boost|lift|roi|return|accuracy|uptime|coverage|adoption|efficiency|productivity';

const PATTERNS = [
  // 10x faster deployments
  { re: new RegExp(`\\b(\\d{1,4}(?:[.,]\\d+)?\\s*[x×])\\s+((?:${CLAIM_VERBS})(?:\\s+[a-z][a-z-]{1,18}){0,2})`, 'gi'), kind: 'multiplier' },
  // 40% faster / 99.99% uptime
  { re: new RegExp(`\\b(\\d{1,3}(?:[.,]\\d{1,3})?\\s*%)\\s+((?:${CLAIM_VERBS})(?:\\s+[a-z][a-z-]{1,18}){0,2})`, 'gi'), kind: 'percent' },
  // reduce onboarding time by 60%
  { re: new RegExp(`\\b((?:${CLAIM_VERBS})(?:\\s+[a-z][a-z-]{1,18}){0,3})\\s+by\\s+(\\d{1,3}(?:[.,]\\d{1,2})?\\s*%)`, 'gi'), kind: 'percent-trailing', swap: true },
  // 10,000+ teams / 5M developers
  { re: new RegExp(`\\b(\\d{1,3}(?:[,.]\\d{3})+|\\d{1,4}(?:\\.\\d)?\\s*(?:k|m|bn?)\\b|\\d{2,6})\\s*\\+?\\s+(${COUNT_NOUNS})\\b`, 'gi'), kind: 'count' },
  // $2.4M saved / €500k in revenue
  { re: /([$€£]\s?\d{1,3}(?:[,.]\d+)*\s*(?:k|m|bn?|billion|million|trillion)?\+?)\s+(?:in\s+)?((?:[a-z][a-z-]{1,18}\s*){1,3})/gi, kind: 'money' },
  // in under 5 minutes
  { re: /\b(?:in|under|within|less than)\s+(\d{1,3})\s+(seconds?|minutes?|hours?|days?|weeks?)\b/gi, kind: 'time' },
  // Fortune 500 / #1 rated
  { re: /\b(fortune\s?(?:100|500)|g2\s+(?:leader|#1)|#\s?1\s+(?:rated\s+)?[a-z][a-z\s-]{2,24})/gi, kind: 'rank' },
];

/** Bare four-digit numbers in year range are dates, not proof. */
const YEARISH = /^(?:1[89]\d\d|20\d\d|21\d\d)$/;

const BOILERPLATE = /copyright|all rights reserved|®|privacy policy|cookie/i;

/**
 * Extract quantified marketing claims from a page.
 *
 * Takes already-flattened plain text: the caller computes it once and shares it
 * with every extractor that needs it, because a full tag-strip over a 1MB
 * document is one of the two most expensive things we do.
 *
 * Returns a stable, sorted, de-duplicated list so that reordering the hero
 * carousel does not read as a positioning change.
 */
export function extractProofPoints(plain) {
  const found = new Map(); // normalised -> {claim, kind}

  for (const { re, kind, swap } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    let n = 0;
    while ((m = re.exec(plain)) !== null && n++ < 300) {
      let a = collapse(m[1] ?? '');
      let b = collapse(m[2] ?? '');
      if (swap) [a, b] = [b, a];
      let claim = collapse(`${a} ${b}`).replace(/[.,;:!?]+$/, '');
      if (!claim || claim.length < 4 || claim.length > 60) continue;
      if (BOILERPLATE.test(claim)) continue;
      // "2024 customers" is a year that happens to precede a noun.
      const lead = /^\d+/.exec(claim)?.[0];
      if (lead && YEARISH.test(lead) && !/[,.+]/.test(claim.slice(0, lead.length + 1))) continue;
      const key = claim.toLowerCase();
      if (!found.has(key)) found.set(key, { claim: key, kind });
    }
  }

  if (found.size === 0) return null;

  const items = [...found.values()]
    .sort((x, y) => x.claim.localeCompare(y.claim))
    .slice(0, 25);

  return ok(items.map((i) => i.claim).join(' | '), 'regex-claims', 0.7, {
    items,
    count: items.length,
  });
}

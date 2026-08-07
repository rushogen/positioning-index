/**
 * Bounded HTML primitives.
 *
 * WHY THERE IS NO DOM PARSER HERE
 * -------------------------------
 * This runs on a Cloudflare Worker on the free plan: 10ms of CPU per
 * invocation. A modern B2B SaaS homepage is 300kB-1.5MB of HTML. Building a
 * full DOM out of that costs tens of milliseconds and would blow the budget on
 * every single page. HTMLRewriter (the Workers-native streaming parser) is
 * cheap but is push-based and awkward for "find the first h1, then look at what
 * follows it" queries, which is most of what we need.
 *
 * So: single-pass, linear-time, non-backtracking regex over a size-capped
 * string. Every pattern in this file uses lazy quantifiers bounded by a literal
 * close tag, or a negated character class. None of them can backtrack
 * catastrophically. Every entry point caps its input length.
 *
 * The measured cost of a full 11-signal extraction over a 500kB page is
 * reported by scripts/probe.js; on the pages in seed/companies.json it lands in
 * the low single-digit milliseconds on Worker-class hardware.
 *
 * The tradeoff is honest: this is a heuristic extractor, not a parser. It will
 * be wrong sometimes. That is exactly why every signal carries a `method` and a
 * `confidence`, why the diff engine refuses to report a change it cannot
 * corroborate, and why METHODOLOGY.md exists.
 */

/** Hard cap on how much HTML we will look at. Everything past this is ignored. */
export const MAX_HTML = 1_200_000;

/**
 * The hero lives at the top of the document. Headline, subhead and category
 * extraction only look at this prefix, which keeps the most-run code path cheap
 * and stops us picking up an <h1> from a footer or a blog teaser.
 */
export const HERO_WINDOW = 120_000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', trade: '™', reg: '®',
  copy: '©', middot: '·', bull: '•', deg: '°',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  times: '×', divide: '÷', laquo: '«', raquo: '»',
  shy: '', zwnj: '', zwj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};

/** Decode the entity subset that actually shows up in marketing copy. */
export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** Collapse all whitespace runs (including nbsp and zero-width) to single spaces. */
export function collapse(s) {
  if (!s) return '';
  return s
    .replace(/[   ​‌‍﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove everything that contains text but is not content: scripts, styles,
 * inline SVG (huge on modern sites, and full of <title> elements that would
 * poison title extraction), templates, comments.
 *
 * Called once per page; every other function operates on the result.
 */
export function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ');
}

/** Tags to text: strip markup, decode entities, collapse whitespace. */
export function text(fragment) {
  if (!fragment) return '';
  return collapse(decodeEntities(fragment.replace(/<[^>]*>/g, ' ')));
}

/**
 * Read one attribute out of a start tag. Handles double quotes, single quotes
 * and unquoted values. `tag` is the raw start tag including angle brackets.
 */
export function attr(tag, name) {
  if (!tag) return null;
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/**
 * Iterate every occurrence of an element, yielding { tag, inner, index }.
 * `inner` is the raw markup between the start and end tag.
 *
 * Void/self-closing elements are handled by passing `{ void: true }`, in which
 * case `inner` is always ''.
 */
export function* elements(html, name, opts = {}) {
  const isVoid = opts.void === true;
  const limit = opts.limit ?? 400;
  const open = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  const closeStr = `</${name}`;
  let count = 0;
  let m;
  while ((m = open.exec(html)) !== null) {
    if (++count > limit) return;
    const tag = m[0];
    if (isVoid || tag.endsWith('/>')) {
      yield { tag, inner: '', index: m.index };
      continue;
    }
    const from = m.index + tag.length;
    const end = html.toLowerCase().indexOf(closeStr, from);
    // Unclosed tag: take a bounded slice rather than running to end of document.
    const inner = end === -1 ? html.slice(from, from + 2000) : html.slice(from, end);
    yield { tag, inner, index: m.index };
    if (end !== -1) open.lastIndex = end;
  }
}

/** First matching element, or null. */
export function firstElement(html, name, opts = {}) {
  for (const el of elements(html, name, opts)) return el;
  return null;
}

/** Content of `<meta name="x">` or `<meta property="x">`, case-insensitive. */
export function meta(html, key) {
  const wanted = key.toLowerCase();
  for (const { tag } of elements(html, 'meta', { void: true, limit: 200 })) {
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? attr(tag, 'itemprop') ?? '').toLowerCase();
    if (name === wanted) {
      const content = attr(tag, 'content');
      if (content) {
        const v = collapse(content);
        if (v) return v;
      }
    }
  }
  return null;
}

/**
 * Parse every <script type="application/ld+json"> block.
 *
 * Returns a flat array of objects: @graph is unwrapped, top-level arrays are
 * spread. Malformed blocks are skipped silently -- a broken JSON-LD island is
 * extremely common and is not an error on our side.
 *
 * Note this reads from the ORIGINAL html, before stripNonContent removed
 * scripts, so callers must pass the raw string.
 */
export function jsonLd(rawHtml) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  let blocks = 0;
  while ((m = re.exec(rawHtml)) !== null && blocks++ < 12) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const push = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(push); return; }
      if (Array.isArray(node['@graph'])) { node['@graph'].forEach(push); return; }
      out.push(node);
    };
    push(parsed);
  }
  return out;
}

/** Normalise a URL fragment for storage: absolute where possible, no tracking noise. */
export function absoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Trim, cap length, and null out anything that is empty or obviously junk. */
export function clean(value, maxLen = 400) {
  const v = collapse(decodeEntities(value ?? ''));
  if (!v) return null;
  if (v.length > maxLen) return v.slice(0, maxLen).trimEnd() + '…';
  return v;
}

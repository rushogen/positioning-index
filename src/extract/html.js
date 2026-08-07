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
 * Remove markup that carries text but is not content: scripts, styles,
 * noscript, templates, comments.
 *
 * Inline SVG is deliberately KEPT here. Customer logo walls are very often
 * inline <svg><title>Shopify</title>, and dropping them early would lose the
 * single richest source for that signal.
 */
export function stripCode(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ');
}

/**
 * Second pass, run over the output of stripCode. Drops inline SVG, which on a
 * modern marketing page can be 40% of the bytes and whose <title> elements
 * would otherwise poison <title> and heading extraction.
 *
 * Two passes rather than one because the second only ever runs over the
 * already-reduced string, so the extra cost is small and the logo extractor
 * gets the markup it needs.
 */
export function stripSvg(html) {
  return html.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, ' ');
}

/** Convenience: both passes. */
export function stripNonContent(html) {
  return stripSvg(stripCode(html));
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
  // Bounded lookahead for the closing tag. Everything this module iterates
  // (headings, paragraphs, img, svg, meta, title) has small inner content, so
  // a fixed window keeps the whole loop O(elements) instead of O(elements x
  // document length). The earlier version called html.toLowerCase() per
  // element, which made a 1.2MB page cost ~160ms on its own.
  const maxInner = opts.maxInner ?? 24_000;
  const open = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  const close = new RegExp(`</${name}\\s*>`, 'i');
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
    const window = html.slice(from, from + maxInner);
    const cm = close.exec(window);
    // Unclosed (or absurdly long) element: take a bounded slice rather than
    // running to the end of the document.
    const inner = cm ? window.slice(0, cm.index) : window.slice(0, 2000);
    yield { tag, inner, index: m.index };
    if (cm) open.lastIndex = from + cm.index;
  }
}

/**
 * Drop `aria-hidden="true"` subtrees.
 *
 * This is not a nicety, it is how you read a modern hero correctly. Linear's
 * <h1> contains three visually-duplicated copies of the headline (a mobile
 * variant, a desktop variant, and per-word animation spans) all wrapped in
 * aria-hidden="true", plus one canonical copy in a visually-hidden span. Naive
 * tag-stripping returns the headline three times. Honouring aria-hidden returns
 * exactly the string a screen reader would announce, which is the string the
 * company actually wrote.
 *
 * Bounded: only runs on fragments, uses a depth counter, gives up past a cap.
 */
export function removeAriaHidden(fragment) {
  if (!fragment || fragment.length > 40_000 || !/aria-hidden/i.test(fragment)) return fragment;
  const opener = /<([a-zA-Z][\w-]*)\b[^>]*\baria-hidden\s*=\s*["']?true["']?[^>]*>/gi;
  let out = fragment;
  for (let pass = 0; pass < 8; pass++) {
    opener.lastIndex = 0;
    const m = opener.exec(out);
    if (!m) break;
    const tagName = m[1];
    if (m[0].endsWith('/>')) { out = out.slice(0, m.index) + out.slice(m.index + m[0].length); continue; }
    // Walk forward counting nested same-name tags to find the true close.
    const scan = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
    scan.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = -1;
    let step;
    while ((step = scan.exec(out)) !== null) {
      depth += step[1] ? -1 : 1;
      if (depth === 0) { end = step.index + step[0].length; break; }
    }
    if (end === -1) { out = out.slice(0, m.index); break; }
    out = out.slice(0, m.index) + ' ' + out.slice(end);
  }
  return out;
}

/**
 * Collapse a string that is the same phrase repeated.
 *
 * Responsive markup frequently renders the headline two or three times and
 * hides all but one with CSS, which we cannot evaluate. If the text is P
 * repeated (optionally ending mid-repeat, because `clean` may have truncated
 * it), return P.
 */
export function dedupeRepeats(s) {
  if (!s || s.length < 24) return s;
  const probe = s.slice(0, Math.min(40, Math.floor(s.length / 2)));
  const next = s.indexOf(probe, 1);
  if (next < 4) return s;
  const unit = s.slice(0, next).trim();
  if (unit.length < 8) return s;
  // Every subsequent chunk must be the unit, or a prefix of it (truncated tail).
  for (let i = next; i < s.length; i += unit.length + 1) {
    const chunk = s.slice(i, i + unit.length).trim();
    if (chunk.length === 0) break;
    if (unit.startsWith(chunk) || chunk.startsWith(unit)) continue;
    return s;
  }
  return unit;
}

/** Text of a heading: aria-hidden dropped, tags stripped, repeats collapsed. */
export function headingText(inner) {
  return dedupeRepeats(text(removeAriaHidden(inner)));
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
